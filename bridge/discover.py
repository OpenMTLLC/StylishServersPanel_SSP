#!/usr/bin/env python3
"""Bounded read-only Minecraft discovery. Never imports/executes server scripts."""
import json
import errno
import os
from pathlib import Path
import re
import shutil
import shlex
import socket
import struct
import sys
import time
import uuid
import zipfile
try:
    import tomllib
except ImportError:
    tomllib = None

GIB = 1073741824.0
SKIP = {"node_modules", "libraries", "cache", "logs", "region", "playerdata", "stats", "advancements", "__pycache__"}


def text(path, limit=262144):
    try:
        if path.is_symlink() or not path.is_file() or path.stat().st_size > limit:
            return ""
        with path.open("r", encoding="utf-8", errors="replace") as file:
            return file.read(limit)
    except OSError:
        return ""


def mod_metadata(path):
    record = {"id": "manual:" + path.name, "name": path.stem, "version": None, "filename": path.name, "provider": "manual", "managed": False, "enabled": None}
    try:
        if path.is_symlink():
            return record
        with zipfile.ZipFile(path) as jar:
            for name in ("fabric.mod.json", "META-INF/neoforge.mods.toml", "META-INF/mods.toml", "plugin.yml"):
                try:
                    info = jar.getinfo(name)
                except KeyError:
                    continue
                if info.file_size > 262144:
                    continue
                content = jar.read(info).decode("utf-8", "replace")
                if name.endswith(".json"):
                    value = json.loads(content)
                    record.update(name=value.get("name") or value.get("id") or record["name"], version=value.get("version"), modId=value.get("id"), loader="fabric")
                    record["environment"] = value.get("environment", "*")
                elif name.endswith(".toml"):
                    value = tomllib.loads(content) if tomllib else {}
                    mods = value.get("mods", [])
                    if mods:
                        value = mods[0]
                        record.update(name=value.get("displayName") or value.get("modId") or record["name"], version=value.get("version"), modId=value.get("modId"))
                    else:
                        for key, field in (("displayName", "name"), ("modId", "modId"), ("version", "version")):
                            match = re.search(r"(?m)^\s*" + key + r"\s*=\s*['\"]([^'\"]+)['\"]", content)
                            if match:
                                record[field] = match.group(1)
                    record["loader"] = "neoforge" if "neoforge" in name else "forge"
                    if record.get("version", "") == "${file.jarVersion}":
                        try:
                            manifest = jar.read("META-INF/MANIFEST.MF").decode("utf-8", "replace")
                            match = re.search(r"(?m)^Implementation-Version:\s*(.+)", manifest)
                            record["version"] = match.group(1).strip() if match else None
                        except KeyError:
                            record["version"] = None
                else:
                    for key, field in (("name", "name"), ("version", "version")):
                        match = re.search(r"(?m)^" + key + r":\s*['\"]?([^\r\n'\"]+)", content)
                        if match:
                            record[field] = match.group(1).strip()
                    record["loader"] = "paper"
                break
    except (OSError, ValueError, zipfile.BadZipFile):
        record["metadataWarning"] = "JAR metadata okunamadı."
    return record


def scan_mods(directory):
    values = []
    for subdir in ("mods", "plugins"):
        folder = directory / subdir
        if folder.is_symlink():
            continue
        try:
            for path in sorted(folder.glob("*.jar"))[:512]:
                values.append(mod_metadata(path))
        except OSError:
            pass
    try:
        records = json.loads(text(directory / ".ssp-mods.json", 4 * 1024 * 1024))
        allowed = {"id", "name", "version", "projectId", "versionId", "provider", "managed", "filename", "description", "author", "dependencies"}
        by_filename = {value.get("filename"): {key: field for key, field in value.items() if key in allowed} for value in records.values() if isinstance(value, dict)} if isinstance(records, dict) else {}
        values = [{**value, **by_filename.get(value["filename"], {})} for value in values]
    except (ValueError, OSError):
        pass
    return values


def varint(value):
    value &= 0xffffffff
    result = bytearray()
    while True:
        result.append((value & 0x7f) | (0x80 if value > 0x7f else 0))
        value >>= 7
        if not value:
            return bytes(result)


def recv_exact(connection, length):
    output = bytearray()
    while len(output) < length:
        block = connection.recv(length - len(output))
        if not block:
            raise OSError("short status packet")
        output.extend(block)
    return bytes(output)


def read_varint(connection):
    value = 0
    for index in range(5):
        byte = recv_exact(connection, 1)[0]
        value |= (byte & 0x7f) << (7 * index)
        if not byte & 0x80:
            return value
    raise OSError("invalid status length")


def status_ping(port, timeout=0.7):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=timeout) as connection:
            connection.settimeout(timeout)
            host = b"localhost"
            handshake = varint(0) + varint(-1) + varint(len(host)) + host + struct.pack(">H", port) + varint(1)
            connection.sendall(varint(len(handshake)) + handshake + b"\x01\x00")
            length = read_varint(connection)
            if length < 2 or length > 1048576 or read_varint(connection) != 0:
                return None
            size = read_varint(connection)
            if size > length or size > 1048576:
                return None
            value = json.loads(recv_exact(connection, size))
            return value if isinstance(value, dict) else None
    except (OSError, ValueError):
        return None


class ProcessList(list):
    complete = True


def java_processes(proc=Path("/proc")):
    found = ProcessList()
    try:
        entries = list(proc.iterdir())
        found.complete = len(entries) <= 8192
        entries = entries[:8192]
    except OSError:
        found.complete = False
        return found
    for entry in entries:
        if not entry.name.isdigit():
            continue
        try:
            if hasattr(os, "getuid") and entry.stat().st_uid != os.getuid():
                continue
            with (entry / "cmdline").open("rb") as file:
                arguments = file.read(65536).decode("utf-8", "replace").split("\0")
            if not arguments or Path(arguments[0]).name not in ("java", "javaw"):
                continue
            cwd = (entry / "cwd").resolve(strict=True)
            safe_args = [arg for arg in arguments[1:] if arg.startswith(("-Xmx", "-Xms", "@")) or arg == "-jar" or arg.endswith(".jar")]
            status = text(entry / "status")
            rss = re.search(r"(?m)^VmRSS:\s*(\d+) kB", status)
            found.append({"directory": str(cwd), "args": safe_args, "memory": int(rss.group(1)) * 1024 / GIB if rss else None})
        except (OSError, RuntimeError):
            if entry.exists():
                found.complete = False
    return found


def confirmed_stopped(directory, processes, port):
    if not getattr(processes, "complete", False) or not hasattr(os, "getuid") or directory.stat().st_uid != os.getuid():
        return False
    try:
        # Any interface listener on the configured port defeats a stopped claim.
        found_table = False
        for table in (Path("/proc/net/tcp"), Path("/proc/net/tcp6")):
            if table.is_file():
                found_table = True
                for line in text(table, 4 * 1024 * 1024).splitlines()[1:]:
                    fields = line.split()
                    if len(fields) > 3 and fields[3] == "0A" and int(fields[1].rsplit(":", 1)[1], 16) == port:
                        return False
        if not found_table:
            return False
        with socket.socket() as connection:
            connection.settimeout(0.5)
            if connection.connect_ex(("127.0.0.1", port)) != errno.ECONNREFUSED:
                return False
        import fcntl
        for session in directory.glob("*/session.lock"):
            if session.is_symlink():
                return False
            with session.open("rb") as handle:
                fcntl.lockf(handle, fcntl.LOCK_SH | fcntl.LOCK_NB)
                fcntl.lockf(handle, fcntl.LOCK_UN)
        return True
    except (OSError, ValueError, ImportError):
        return False


def candidate_dirs(home, processes, explicit=None):
    if explicit:
        value = Path(explicit).expanduser()
        if not value.is_absolute() or value.is_symlink() or not value.is_dir():
            raise ValueError("Mevcut sunucu dizini mutlak, erişilebilir ve gerçek bir dizin olmalıdır.")
        return [value.resolve()]
    values = {Path(process["directory"]) for process in processes if (Path(process["directory"]) / "server.properties").is_file()}
    visited = 0
    for directory, dirs, files in os.walk(home, topdown=True, followlinks=False):
        visited += 1
        path = Path(directory)
        try:
            depth = len(path.relative_to(home).parts)
        except ValueError:
            continue
        dirs[:] = [name for name in dirs if not name.startswith(".") and name not in SKIP and not (path / name).is_symlink()] if depth < 5 else []
        if "server.properties" in files:
            values.add(path)
            dirs[:] = []
        if visited >= 4000 or len(values) >= 16:
            break
    return sorted(values)[:16]


def inspect_directory(directory, processes, machine, port_override=None):
    props = {}
    for line in text(directory / "server.properties").splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            if key.strip() in ("server-port", "max-players", "level-name"):
                props[key.strip()] = value.strip()
    if not props and not (directory / "server.properties").is_file():
        raise ValueError("Seçilen dizinde Minecraft server.properties bulunamadı.")
    try:
        port = int(port_override or props.get("server-port", "25565"))
        if not 1 <= port <= 65535:
            raise ValueError()
    except (ValueError, TypeError):
        raise ValueError("Minecraft sunucu portu geçersiz.") from None
    process = next((p for p in processes if p["directory"] == str(directory)), None)
    arguments = " ".join(process["args"]) if process else ""
    launcher = text(directory / "run.sh") + text(directory / "start.sh") + text(directory / "user_jvm_args.txt") + arguments
    if process:
        for argument in process["args"]:
            if argument.startswith("@"):
                argfile = (directory / argument[1:]).resolve()
                if argfile.is_relative_to(directory):
                    launcher += "\n" + text(argfile, 65536)
    edition = "vanilla"
    version = None
    neoforge = directory / "libraries/net/neoforged/neoforge"
    forge = directory / "libraries/net/minecraftforge/forge"
    if neoforge.is_dir() or "neoforged/neoforge" in launcher:
        edition = "neoforge"
        versions = sorted([p.name for p in neoforge.iterdir() if p.is_dir()], key=lambda value: tuple(int(n) for n in re.findall(r"\d+", value))) if neoforge.is_dir() else []
        active = re.search(r"net/neoforged/neoforge/([^/\s]+)/unix_args", launcher)
        if active:
            versions = [active.group(1)]
        if versions:
            neo = versions[-1].split(".")
            if len(neo) >= 2 and int(neo[0]) < 26:
                version = "1." + neo[0] + ("." + neo[1] if neo[1] != "0" else "")
            elif len(neo) >= 4:
                version = ".".join(neo[:3])
    elif forge.is_dir() or "minecraftforge/forge" in launcher:
        edition = "forge"
        versions = sorted([p.name for p in forge.iterdir() if p.is_dir()]) if forge.is_dir() else []
        if versions:
            version = versions[-1].split("-")[0]
    elif any(directory.glob("fabric*.jar")) or (directory / ".fabric").is_dir() or "fabric" in launcher.lower():
        edition = "fabric"
    elif (directory / "config/paper-global.yml").is_file() or any(directory.glob("paper*.jar")) or (directory / "paper.yml").is_file():
        edition = "paper"
    # JSON is metadata only. Never read arbitrary environment, auth or plugin configs.
    for filename in ("version.json", "versions/version.json"):
        try:
            value = json.loads(text(directory / filename))
            version = value.get("id") or version
        except (ValueError, AttributeError):
            pass
    try:
        log_file = directory / "logs/latest.log"
        if not log_file.is_symlink() and log_file.is_file():
            with log_file.open("rb") as file:
                size = file.seek(0, 2)
                file.seek(max(0, size - 262144))
                log_tail = file.read(262144).decode("utf-8", "replace")
            match = re.search(r"Starting minecraft server version ([0-9.]+)", log_tail, re.I)
            if match:
                version = match.group(1)
    except OSError:
        pass
    ping = status_ping(port)
    players = ping.get("players", {}) if ping else {}
    if ping:
        match = re.search(r"(?:^|\s)(1\.\d+(?:\.\d+)?|26\.\d+(?:\.\d+)?)", str(ping.get("version", {}).get("name", "")))
        if match:
            version = match.group(1)
    ids = set()
    cache_ids = set()
    known_source = False
    try:
        cache_file = directory / "usercache.json"
        if cache_file.is_file() and not cache_file.is_symlink():
            cache = json.loads(text(cache_file, 4 * 1024 * 1024))
            if isinstance(cache, list):
                for entry in cache[:50000]:
                    try:
                        cache_ids.add(str(uuid.UUID(entry.get("uuid", ""))))
                    except (ValueError, TypeError, AttributeError):
                        pass
    except (OSError, ValueError):
        pass
    level = props.get("level-name", "world")
    world = (directory / level).resolve()
    if world.is_relative_to(directory) and not (directory / level).is_symlink():
        for folder_name in ("playerdata", "stats", "advancements"):
            folder = world / folder_name
            if folder.is_dir() and not folder.is_symlink():
                known_source = True
                for file in list(folder.iterdir())[:50000]:
                    try:
                        ids.add(str(uuid.UUID(file.stem)))
                    except ValueError:
                        pass
    count_source = "world-history" if known_source else "usercache" if cache_ids else None
    if not known_source and cache_ids:
        ids = cache_ids
        known_source = True
    heap = re.search(r"(?:^|\s)-Xmx(\d+(?:\.\d+)?)([kKmMgG])(?:\s|$)", launcher)
    allocated = float(heap.group(1)) * {"k": 1 / 1024, "m": 1, "g": 1024}[heap.group(2).lower()] if heap else None
    disk = shutil.disk_usage(directory)
    mods = scan_mods(directory)
    state = "running" if ping or process else "stopped" if confirmed_stopped(directory, processes, port) else "unknown"
    warnings = []
    if not ping:
        warnings.append("Minecraft durum sorgusu yanıt vermedi; çevrimiçi oyuncu sayısı bilinmiyor.")
    if not process:
        warnings.append("Bu SSH kullanıcısının okuyabildiği çalışan Java işlemiyle dizin eşleştirilemedi.")
    if mods:
        warnings.append("Mod listesi diskteki JAR metadata bilgisidir; gerçekten yüklenmiş modlar için oyun sağlayıcısı gerekir.")
    return {"directory": str(directory), "game": "minecraft", "edition": edition, "version": version, "status": state, "running": True if state == "running" else False if state == "stopped" else None, "address": "127.0.0.1:" + str(port), "port": port, "playersOnline": players.get("online"), "playersTotal": len(ids) if known_source else None, "playersTotalSource": count_source, "maxPlayers": players.get("max") or (int(props["max-players"]) if props.get("max-players", "").isdigit() else None), "mods": mods, "loadedMods": None, "metrics": {"memory": process.get("memory") if process else None, "memoryTotal": allocated / 1024 if allocated is not None else None, "machineMemoryTotal": machine["ramGb"], "allocatedMemoryMb": allocated, "disk": (disk.total - disk.free) / GIB, "diskTotal": disk.total / GIB, "cpu": None, "tps": None}, "warnings": warnings}


def discover(options=None, home=None, proc=None):
    options = options or {}
    home = Path(home or Path.home()).resolve()
    meminfo = text(Path("/proc/meminfo"))
    match = re.search(r"(?m)^MemTotal:\s*(\d+) kB", meminfo)
    disk = shutil.disk_usage(home)
    machine = {"ramGb": int(match.group(1)) * 1024 / GIB if match else None, "diskGb": (disk.total - disk.free) / GIB, "diskTotalGb": disk.total / GIB}
    processes = java_processes(Path(proc or "/proc"))
    values = []
    warnings = []
    for directory in candidate_dirs(home, processes, options.get("directory")):
        try:
            values.append(inspect_directory(directory, processes, machine, options.get("port")))
        except (OSError, ValueError):
            if options.get("directory"):
                raise ValueError("Seçilen dizindeki sunucu metadata bilgisi okunamadı.") from None
            warnings.append("Bir adayın oyun metadata bilgisi okunamadı.")
    if not values:
        warnings.append("Sınırlı ana dizin taramasında sunucu bulunamadı; mutlak sunucu dizinini girin.")
    return {"candidates": values, "machine": machine, "warnings": warnings, "source": "ssh-discovery", "observedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}


if __name__ == "__main__":
    try:
        options = json.loads(sys.argv[1]) if len(sys.argv) > 1 else {}
        print(json.dumps(discover(options), ensure_ascii=False))
    except Exception:
        print(json.dumps({"error": "Sunucu keşfi tamamlanamadı. Dizin izinlerini ve Python 3.10+ kurulumunu kontrol edin."}))
        sys.exit(1)
