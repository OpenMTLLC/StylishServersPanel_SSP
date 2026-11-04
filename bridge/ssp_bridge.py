#!/usr/bin/env python3
"""SSP remote process/Modrinth bridge. Python 3.10+, standard library only.

The listener intentionally binds loopback. Reach it with SSP's pinned SSH tunnel.
Minecraft-specific player/chat/inventory data comes from the Paper companion or
another provider implementing the same authenticated HTTP protocol.
"""
from __future__ import annotations
import hashlib
import hmac
import json
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import tempfile
import zipfile
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from contextlib import contextmanager
from functools import wraps
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
try:
    from discover import scan_mods
except ImportError:
    scan_mods = None

TOKEN = os.environ.get("SSP_BRIDGE_TOKEN", "")
ROOT = Path(os.environ.get("SSP_SERVER_DIR", ".")).resolve()
VERSION = os.environ.get("SSP_GAME_VERSION", "1.21.4")
LOADER = os.environ.get("SSP_LOADER", "paper")
PLUGIN_URL = os.environ.get("SSP_PROVIDER_URL", "http://127.0.0.1:8787").rstrip("/")
PLUGIN_TOKEN = os.environ.get("SSP_PROVIDER_TOKEN", TOKEN)
PORT = int(os.environ.get("SSP_BRIDGE_PORT", "8765"))
USER_AGENT = "StylishServersPanel_SSP/0.2 (https://github.com/OpenMTLLC/StylishServersPanel_SSP)"
LOGS: deque[dict] = deque(maxlen=500)
LOG_LOCK = threading.RLock()
PROCESS: subprocess.Popen | None = None
STARTED = 0.0
LOCK = threading.RLock()
MOD_LOCK = threading.Lock()
FILE_OPERATION_LOCK = threading.RLock()
OPERATION_DEPTH = threading.local()
CACHE: dict = {}


class BridgeError(Exception):
    def __init__(self, message: str, status: int = 400):
        self.status = status
        super().__init__(message)


def log(message: str, level: str = "info"):
    with LOG_LOCK:
        LOGS.append({"timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "level": level, "message": message[:4000]})


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def running():
    return PROCESS is not None and PROCESS.poll() is None


def provider(path: str, method: str = "GET", body=None):
    parsed = urllib.parse.urlsplit(PLUGIN_URL)
    if parsed.scheme != "http" or parsed.hostname not in ("127.0.0.1", "localhost", "::1") or parsed.username:
        raise BridgeError("Oyun sağlayıcısı localhost HTTP adresi olmalıdır.", 503)
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(PLUGIN_URL + path, data=data, method=method, headers={"Authorization": "Bearer " + PLUGIN_TOKEN, "Content-Type": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=12) as response:
            return json.loads(response.read(4 * 1024 * 1024))
    except urllib.error.HTTPError as error:
        try:
            message = json.loads(error.read(8192)).get("error", "Oyun sağlayıcısı işlemi reddetti.")
        except (ValueError, AttributeError):
            message = "Oyun sağlayıcısı işlemi reddetti."
        raise BridgeError(message, error.code if error.code >= 400 else 502) from None
    except (OSError, ValueError):
        raise BridgeError("Oyuncu, sohbet ve envanter için SSP oyun sağlayıcısı bağlı olmalıdır. docs/BRIDGE.md dosyasına bakın.", 503) from None


def state():
    global CACHE
    try:
        CACHE = provider("/state")
        result = dict(CACHE)
        result["status"] = "running"
        result["providerConnected"] = True
    except BridgeError:
        result = dict(CACHE)
        result["players"] = [{**p, "online": False, "ping": 0} for p in result.get("players", [])]
        result["status"] = "running" if running() else "stopped"
        result["providerConnected"] = False
        result["providerMessage"] = "Oyun içi veri sağlayıcısı bağlı değil."
        result["inventoryProviders"] = []
    result.setdefault("players", [])
    result.setdefault("chat", [])
    result.setdefault("inventoryProviders", [])
    result["mods"] = installed_mods()
    with LOG_LOCK:
        result["console"] = list(LOGS)
    metrics = result.setdefault("metrics", {})
    metrics.setdefault("uptime", int(time.monotonic() - STARTED) if running() else 0)
    for key in ("cpu", "memory", "memoryTotal", "disk", "diskTotal", "tps", "networkIn", "networkOut"):
        metrics.setdefault(key, None)
    return result


def reader(process):
    try:
        for line in process.stdout:
            log(line.rstrip())
    finally:
        log("Sunucu işlemi kapandı (kod: %s)." % process.wait())


def power(action):
    global PROCESS, STARTED
    if action not in ("start", "stop", "restart"):
        raise BridgeError("Geçersiz güç işlemi.")
    with LOCK:
        if action in ("stop", "restart"):
            if running():
                PROCESS.stdin.write("stop\n")
                PROCESS.stdin.flush()
                try:
                    PROCESS.wait(timeout=30)
                except subprocess.TimeoutExpired:
                    raise BridgeError("Sunucu 30 saniyede kapanmadı; dünya güvenliği için zorla sonlandırılmadı.", 409) from None
            elif action == "stop":
                raise BridgeError("Köprünün yönettiği çalışan sunucu yok.", 409)
        if action in ("start", "restart"):
            if running():
                raise BridgeError("Sunucu zaten çalışıyor.", 409)
            command = shlex.split(os.environ.get("SSP_START_COMMAND", "./start.sh"))
            if not command:
                raise BridgeError("Başlatma komutu yapılandırılmamış.")
            try:
                PROCESS = subprocess.Popen(command, cwd=ROOT, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, shell=False)
            except OSError:
                raise BridgeError("Sunucu başlatılamadı. start.sh ve Java kurulumunu kontrol edin.", 503) from None
            STARTED = time.monotonic()
            threading.Thread(target=reader, args=(PROCESS,), daemon=True).start()
            log("Sunucu başlatma isteği gönderildi; oyun hazır olana kadar günlükleri izleyin.")
        return {"status": "running" if running() else "stopped", "accepted": True}


def command(text):
    if not isinstance(text, str) or not text.strip() or len(text) > 2000 or "\n" in text or "\r" in text:
        raise BridgeError("Komut tek satır ve en fazla 2000 karakter olmalıdır.")
    with LOCK:
        if not running():
            raise BridgeError("Komut göndermek için sunucu SSP köprüsüyle başlatılmalıdır.", 409)
        PROCESS.stdin.write(text.lstrip("/") + "\n")
        PROCESS.stdin.flush()
        verb = text.lstrip("/").split(" ", 1)[0].lower()
        log("> " + (verb + " [gizli parametreler]" if verb in ("login", "register", "changepassword", "auth", "password", "l", "reg") else text))
    return {"accepted": True}


def registry():
    filename = ROOT / ".ssp-mods.json"
    if filename.is_symlink():
        raise BridgeError("Mod kayıt dosyası sembolik bağlantı olamaz.", 409)
    if not filename.exists():
        return {}
    if filename.stat().st_size > 4 * 1024 * 1024:
        raise BridgeError("Mod kayıt dosyası boyut sınırını aşıyor.", 409)
    try:
        data = json.loads(filename.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        raise BridgeError("Mod kayıt dosyası okunamadı; işlem durduruldu.", 500) from None


def installed_mods():
    records = registry()
    by_filename = {record.get("filename"): record for record in records.values()}
    if scan_mods:
        return [{**mod, **by_filename.get(mod.get("filename"), {})} for mod in scan_mods(ROOT)]
    values = []
    for folder in ("plugins", "mods"):
        for path in sorted((ROOT / folder).glob("*.jar"))[:512]:
            values.append(by_filename.get(path.name) or {"id": "manual:" + path.name, "name": path.stem, "filename": path.name, "version": None, "provider": "manual", "managed": False, "enabled": None})
    return values


def ensure_stopped():
    if running():
        raise BridgeError("Dosya güvenliği için önce sunucuyu durdurun.", 409)
    try:
        provider("/state")
    except BridgeError as error:
        if error.status != 503:
            raise BridgeError("Oyunun durduğu doğrulanamadı.", 409) from None
    else:
        raise BridgeError("Oyun başka bir süreçte çalışıyor. Dosyaları değiştirmeden önce durdurun.", 409)
    # Java FileChannel session locks use POSIX record locks on Linux.
    # This catches a Fabric/vanilla process even when no player provider exists.
    if os.name == "posix":
        import fcntl
        for session in ROOT.glob("*/session.lock"):
            try:
                with session.open("r+b") as handle:
                    fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    fcntl.lockf(handle, fcntl.LOCK_UN)
            except OSError:
                raise BridgeError("Minecraft dünya kilidi etkin; önce oyunu durdurun.", 409) from None


def save_registry(data):
    temporary = ROOT / ".ssp-mods.json.tmp"
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2), "utf-8")
    temporary.replace(ROOT / ".ssp-mods.json")


@contextmanager
def mod_operation_lock():
    """Serialize daemon and one-shot mutations in the same game directory."""
    with FILE_OPERATION_LOCK:
        if getattr(OPERATION_DEPTH, "value", 0):
            OPERATION_DEPTH.value += 1
            try:
                yield
            finally:
                OPERATION_DEPTH.value -= 1
            return
        descriptor = None
        try:
            if os.name == "posix":
                import fcntl
                descriptor = os.open(ROOT / ".ssp-mod-operation.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
                try:
                    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise BridgeError("Bu sunucuda başka bir mod işlemi sürüyor; tamamlanmasını bekleyin.", 409) from None
            OPERATION_DEPTH.value = 1
            yield
        finally:
            OPERATION_DEPTH.value = 0
            if descriptor is not None:
                os.close(descriptor)


def mod_mutation(function):
    @wraps(function)
    def wrapped(*args, **kwargs):
        with mod_operation_lock():
            return function(*args, **kwargs)
    return wrapped


def modrinth(path):
    request = urllib.request.Request("https://api.modrinth.com/v2" + path, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read(4 * 1024 * 1024))
    except (OSError, ValueError):
        raise BridgeError("Modrinth verileri alınamadı.", 502) from None


def curseforge(path, api_key):
    if not isinstance(api_key, str) or len(api_key) < 10 or len(api_key) > 512 or any(ord(c) < 32 or ord(c) > 126 for c in api_key):
        raise BridgeError("CurseForge için geçerli bir API anahtarı yapılandırın.", 409)
    request = urllib.request.Request("https://api.curseforge.com/v1" + path, headers={"User-Agent": USER_AGENT, "x-api-key": api_key, "Accept": "application/json"})
    try:
        with urllib.request.build_opener(NoRedirect).open(request, timeout=20) as response:
            return json.loads(response.read(4 * 1024 * 1024))["data"]
    except (OSError, ValueError, KeyError):
        raise BridgeError("CurseForge API isteği başarısız. Anahtarın yetkisini kontrol edin.", 502) from None


def allowed_cdn(url, provider):
    parsed = urllib.parse.urlsplit(url)
    host = (parsed.hostname or "").lower()
    hosts = ["cdn.modrinth.com"] if provider == "modrinth" else ["forgecdn.net"]
    return parsed.scheme == "https" and not parsed.username and not parsed.password and any(host == domain or provider == "curseforge" and host.endswith("." + domain) for domain in hosts)


class CDNRedirect(urllib.request.HTTPRedirectHandler):
    def __init__(self, provider):
        self.provider = provider
    def redirect_request(self, request, fp, code, message, headers, new_url):
        if not allowed_cdn(new_url, self.provider):
            raise BridgeError("İzin verilmeyen CDN yönlendirmesi reddedildi.")
        # API credentials never enter a CDN request, including redirects.
        return urllib.request.Request(new_url, headers={"User-Agent": USER_AGENT})


def _identity(value, label):
    if not isinstance(value, (str, int)) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", str(value)):
        raise BridgeError(label + " kimliği geçersiz.")
    return str(value)


def _resolve_modrinth(project_id, version_id):
    pinned = modrinth("/version/" + _identity(version_id, "Modrinth sürüm")) if version_id else None
    if pinned and not project_id:
        project_id = pinned["project_id"]
    project = modrinth("/project/" + _identity(project_id, "Modrinth proje"))
    loaders = ["paper", "spigot", "bukkit"] if LOADER == "paper" else [LOADER]
    query = urllib.parse.urlencode({"game_versions": json.dumps([VERSION]), "loaders": json.dumps(loaders)})
    versions = [pinned] if pinned else modrinth("/project/" + str(project["id"]) + "/version?" + query)
    compatible = [v for v in versions if str(v.get("project_id", project["id"])) == str(project["id"]) and VERSION in v.get("game_versions", []) and set(loaders).intersection(v.get("loaders", [])) and v.get("version_type") == "release"]
    compatible.sort(key=lambda v: v.get("date_published", ""), reverse=True)
    chosen = next(iter(compatible), None)
    if not chosen or project.get("server_side") == "unsupported":
        raise BridgeError("Modrinth projesinin sunucu/oyun/yükleyiciyle uyumlu kararlı sürümü yok.", 409)
    files = [file for file in chosen.get("files", []) if file.get("filename", "").endswith(".jar")]
    artifact = next((file for file in files if file.get("primary")), None) or next(iter(files), None)
    if not artifact:
        raise BridgeError("Projede bir sunucu JAR dosyası bulunamadı.", 409)
    dependencies = [(dep.get("project_id"), dep.get("version_id")) for dep in chosen.get("dependencies", []) if dep.get("dependency_type") == "required"]
    return {"id": "modrinth:" + str(project["id"]), "projectId": str(project["id"]), "name": project.get("title", project_id), "version": chosen["version_number"], "versionId": chosen["id"], "author": project.get("slug", "Modrinth"), "description": project.get("description", ""), "enabled": True, "managed": True, "filename": artifact["filename"], "hashAlgorithm": "sha512", "hash": artifact.get("hashes", {}).get("sha512", ""), "provider": "modrinth", "url": artifact["url"], "dependencyRefs": dependencies}


def _resolve_curseforge(project_id, version_id, api_key):
    project_id = _identity(project_id, "CurseForge proje")
    if not project_id.isdigit() or version_id is not None and not str(version_id).isdigit():
        raise BridgeError("CurseForge sayısal proje/dosya kimliği gerektirir.")
    if LOADER not in ("forge", "fabric", "neoforge"):
        raise BridgeError("CurseForge otomatik kurulumu Forge, Fabric ve NeoForge modları içindir.", 409)
    project = curseforge("/mods/" + project_id, api_key)
    if project.get("allowModDistribution") is False:
        raise BridgeError("Mod yazarı üçüncü taraf dağıtımını kapatmış; otomatik indirme yapılamaz.", 409)
    if project.get("gameId") != 432 or project.get("classId") != 6:
        raise BridgeError("CurseForge projesi bir Minecraft modu değil.", 409)
    if project.get("isClientOnly") or project.get("clientOnly"):
        raise BridgeError("Yalnız istemci modu sunucuya kurulamaz.", 409)
    loader_number = {"forge": 1, "fabric": 4, "neoforge": 6}[LOADER]
    query = urllib.parse.urlencode({"gameVersion": VERSION, "modLoaderType": loader_number, "pageSize": 50})
    files = [curseforge(f"/mods/{project_id}/files/{version_id}", api_key)] if version_id else curseforge(f"/mods/{project_id}/files?{query}", api_key)
    compatible = [file for file in files if file.get("modId") == int(project_id) and VERSION in file.get("gameVersions", []) and LOADER.lower() in [str(v).lower() for v in file.get("gameVersions", [])] and file.get("releaseType") == 1 and file.get("isAvailable") is not False]
    compatible.sort(key=lambda file: file.get("fileDate", ""), reverse=True)
    chosen = next(iter(compatible), None)
    if not chosen:
        raise BridgeError("CurseForge projesinin bu oyun/yükleyici için kararlı sürümü yok.", 409)
    if not chosen.get("downloadUrl"):
        raise BridgeError("CurseForge dosyası otomatik indirmeye kapalı; izin kısıtı aşılmaz.", 409)
    if chosen.get("isClientOnly") or chosen.get("clientOnly") or "client" in [str(v).lower() for v in chosen.get("gameVersions", [])]:
        raise BridgeError("Yalnız istemci modu sunucuya kurulamaz.", 409)
    checksum = next((value.get("value") for value in chosen.get("hashes", []) if value.get("algo") == 1), None)
    if not checksum:
        raise BridgeError("CurseForge resmî SHA1 özeti yok; dosya kurulmadı.", 409)
    authors = ", ".join(author.get("name", "") for author in project.get("authors", []))
    return {"id": "curseforge:" + project_id, "projectId": project_id, "name": project.get("name", project_id), "version": chosen.get("displayName", str(chosen["id"])), "versionId": str(chosen["id"]), "author": authors, "description": project.get("summary", ""), "enabled": True, "managed": True, "filename": chosen["fileName"], "hashAlgorithm": "sha1", "hash": checksum.lower(), "provider": "curseforge", "url": chosen["downloadUrl"], "dependencyRefs": [(str(dep["modId"]), None) for dep in chosen.get("dependencies", []) if dep.get("relationType") == 3]}


def _jar_ids(path):
    """Read loader identities without executing any code from the archive."""
    identities = set()
    try:
        with zipfile.ZipFile(path) as archive:
            for name in ("fabric.mod.json", "META-INF/neoforge.mods.toml", "META-INF/mods.toml", "plugin.yml"):
                try:
                    entry = archive.getinfo(name)
                except KeyError:
                    continue
                if entry.file_size > 262144:
                    raise BridgeError("Mod kimlik bilgisi boyut sınırını aşıyor.", 409)
                content = archive.read(entry).decode("utf-8", "replace")
                if name.endswith(".json"):
                    identity = json.loads(content).get("id")
                    if isinstance(identity, str):
                        identities.add("mod:" + identity.casefold())
                elif name.endswith(".toml"):
                    # Only [[mods]], not dependency modId fields such as minecraft.
                    for section in re.finditer(r"(?ms)^\s*\[\[mods\]\]\s*(.*?)(?=^\s*\[|\Z)", content):
                        identity = re.search(r"(?m)^\s*modId\s*=\s*['\"]([^'\"]+)['\"]", section.group(1))
                        if identity:
                            identities.add("mod:" + identity.group(1).casefold())
                else:
                    identity = re.search(r"(?m)^name:\s*['\"]?([^\r\n'\"]+)", content)
                    if identity:
                        identities.add("plugin:" + identity.group(1).strip().casefold())
    except (OSError, ValueError, zipfile.BadZipFile):
        return set()
    return identities


def _download_artifact(record, target, budget):
    if not re.fullmatch(r"[A-Za-z0-9._+()\- ]{1,180}\.jar", record.get("filename", "")) or not allowed_cdn(record.get("url", ""), record["provider"]):
        raise BridgeError("Mod dosya adı veya resmî CDN adresi geçersiz.")
    algorithm = record["hashAlgorithm"]
    if algorithm not in ("sha512", "sha1") or not re.fullmatch(r"[a-f0-9]{" + str(128 if algorithm == "sha512" else 40) + r"}", record.get("hash", "")):
        raise BridgeError("Resmî dosya özeti geçersiz.")
    digest = hashlib.new(algorithm)
    request = urllib.request.Request(record["url"], headers={"User-Agent": USER_AGENT})
    with urllib.request.build_opener(CDNRedirect(record["provider"])).open(request, timeout=60) as response, target.open("xb") as output:
        if not allowed_cdn(response.url, record["provider"]):
            raise BridgeError("Mod CDN adresi doğrulanamadı.")
        size = 0
        while block := response.read(65536):
            size += len(block)
            budget[0] += len(block)
            if size > 128 * 1024 * 1024 or budget[0] > 512 * 1024 * 1024:
                raise BridgeError("Mod işlemi dosya boyutu sınırını aşıyor.")
            digest.update(block)
            output.write(block)
    if not hmac.compare_digest(digest.hexdigest(), record["hash"]):
        raise BridgeError("Mod dosya özeti eşleşmiyor; hiçbir mod kurulmadı.")
    # CurseForge has no universal server-side field. Reject explicit Fabric client metadata too.
    try:
        with zipfile.ZipFile(target) as jar:
            info = jar.getinfo("fabric.mod.json")
            if info.file_size <= 262144 and json.loads(jar.read(info)).get("environment") == "client":
                raise BridgeError("JAR yalnız istemci için işaretlenmiş; sunucuya kurulamaz.", 409)
    except KeyError:
        pass
    except (ValueError, zipfile.BadZipFile):
        raise BridgeError("İndirilen dosya geçerli JAR metadata içermiyor.") from None


@mod_mutation
def install_mod(data):
    ensure_stopped()
    provider_name = data.get("provider", "modrinth")
    if provider_name not in ("modrinth", "curseforge") or LOADER not in ("paper", "fabric", "forge", "neoforge"):
        raise BridgeError("Mod sağlayıcısı veya sunucu yükleyicisi desteklenmiyor.", 409)
    _identity(data.get("projectId", ""), "Mod proje")
    api_key = data.get("apiKey") or data.get("curseforgeApiKey")
    records = registry()
    graph = {}
    visiting = set()
    def visit(project_id, version_id=None, depth=0):
        if depth > 16 or len(graph) >= 32:
            raise BridgeError("Zorunlu bağımlılık sınırı aşıldı (32 mod/16 seviye).", 409)
        record = _resolve_modrinth(project_id, version_id) if provider_name == "modrinth" else _resolve_curseforge(project_id, version_id, api_key)
        key = record["id"]
        if key in graph:
            if graph[key]["versionId"] != record["versionId"]:
                raise BridgeError("Bağımlılıklar farklı sürümler gerektiriyor; mevcut dosyalar değiştirilmedi.", 409)
            return key
        graph[key] = record
        visiting.add(key)
        record["dependencies"] = [visit(project, version, depth + 1) for project, version in record.pop("dependencyRefs")]
        visiting.discard(key)
        return key
    root_key = visit(data["projectId"], data.get("versionId"))
    directory = ROOT / ("plugins" if LOADER == "paper" else "mods")
    if directory.is_symlink():
        raise BridgeError("Mod dizini sembolik bağlantı olamaz.", 409)
    existing_ids = {}
    if directory.exists():
        for existing_path in sorted(directory.glob("*.jar"))[:512]:
            if existing_path.is_symlink():
                raise BridgeError("Mod dizininde sembolik JAR bağlantısı var; kimlik çakışması güvenli biçimde denetlenemedi.", 409)
            for identity in _jar_ids(existing_path):
                existing_ids.setdefault(identity, set()).add(existing_path.name)
    planned_ids = {}
    created = []
    staged = []
    updated = dict(records)
    filenames = set()
    try:
        with tempfile.TemporaryDirectory(prefix=".ssp-stage-", dir=ROOT) as temporary:
            budget = [0]
            for key, record in graph.items():
                previous_pair = next(((known_key, value) for known_key, value in records.items() if value.get("provider", "modrinth") == provider_name and str(value.get("projectId", str(value.get("id", "")).split(":")[-1])) == record["projectId"]), None)
                previous = previous_pair[1] if previous_pair else None
                if previous and str(previous.get("versionId")) != str(record["versionId"]):
                    raise BridgeError("Bir bağımlılığın farklı sürümü zaten yüklü; önce mevcut sürümü kaldırın.", 409)
                if record["filename"] in filenames:
                    raise BridgeError("Bağımlılıklar aynı dosya adını kullanıyor.", 409)
                filenames.add(record["filename"])
                target = Path(temporary) / record["filename"]
                _download_artifact(record, target, budget)
                for identity in _jar_ids(target):
                    if any(name != record["filename"] for name in existing_ids.get(identity, set())):
                        raise BridgeError("Bu modun başka bir dosyası zaten yüklü. Önce mevcut sürümü kaldırın; ikinci bir kopya kurulmadı.", 409)
                    if identity in planned_ids and planned_ids[identity] != record["filename"]:
                        raise BridgeError("Seçilen mod ve bağımlılıkları aynı yükleyici kimliğini kullanıyor.", 409)
                    planned_ids[identity] = record["filename"]
                destination = directory / record["filename"]
                if destination.exists():
                    digest = hashlib.new(record["hashAlgorithm"])
                    if destination.is_symlink() or destination.stat().st_size > 128 * 1024 * 1024:
                        raise BridgeError("Aynı adlı dosya güvenli biçimde doğrulanamadı.", 409)
                    with destination.open("rb") as existing:
                        while block := existing.read(65536):
                            digest.update(block)
                    if digest.hexdigest() != record["hash"]:
                        raise BridgeError("Aynı adlı farklı dosya var; üzerine yazılmadı.", 409)
                    if not previous:
                        record["managed"] = False
                    else:
                        updated.pop(previous_pair[0], None)
                        updated[key] = {field: value for field, value in record.items() if field != "url"}
                    continue
                staged.append((target, destination, record))
            # Downloads can take time: re-check immediately before committing any file.
            ensure_stopped()
            directory.mkdir(exist_ok=True)
            for source, destination, record in staged:
                os.link(source, destination)  # Atomic no-replace; staging is on the same filesystem.
                created.append(destination)
                clean = {key: value for key, value in record.items() if key not in ("url",)}
                updated[record["id"]] = clean
            save_registry(updated)
    except BridgeError:
        for destination in reversed(created):
            destination.unlink(missing_ok=True)
        raise
    except OSError:
        for destination in reversed(created):
            destination.unlink(missing_ok=True)
        raise BridgeError("Mod işlemi tamamlanamadı; yeni dosyalar geri alındı.", 502) from None
    result = {key: value for key, value in graph[root_key].items() if key != "url"}
    result["installed"] = [{key: value for key, value in record.items() if key != "url"} for record in graph.values()]
    log("Mod ve zorunlu bağımlılıklar hazır: " + str(result["name"]))
    return result


@mod_mutation
def delete_mod(mod_id):
    ensure_stopped()
    records = registry()
    record = records.get(mod_id)
    if not record:
        raise BridgeError("Yalnızca SSP üzerinden yüklenmiş modlar kaldırılabilir.", 404)
    if record.get("managed") is False:
        raise BridgeError("Elle yüklenmiş dosya SSP tarafından kaldırılamaz.", 409)
    canonical = record.get("provider", "modrinth") + ":" + str(record.get("projectId", mod_id.split(":")[-1]))
    if any(canonical in value.get("dependencies", []) for key, value in records.items() if key != mod_id):
        raise BridgeError("Bu moda bağımlı yüklü modlar var; önce onları kaldırın.", 409)
    filename = record.get("filename", "")
    if not re.fullmatch(r"[A-Za-z0-9._+()\- ]{1,180}\.jar", filename):
        raise BridgeError("Mod dosya kaydı geçersiz.", 409)
    folder = ROOT / ("plugins" if LOADER == "paper" else "mods")
    if folder.is_symlink():
        raise BridgeError("Mod dizini sembolik bağlantı olamaz.", 409)
    path = folder / filename
    # Move to quarantine instead of destroying a server administrator's artifact.
    if path.exists():
        quarantine = ROOT / ".ssp-removed"
        if quarantine.is_symlink():
            raise BridgeError("Karantina dizini sembolik bağlantı olamaz.", 409)
        quarantine.mkdir(exist_ok=True)
        path.rename(quarantine / (str(time.time_ns()) + "-" + filename))
    del records[mod_id]
    save_registry(records)
    log("Mod kaldırıldı: " + record["name"])
    return {"removed": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "SSPBridge/0.2"
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, *_):
        pass  # Never log Authorization or request bodies.

    def reply(self, value, status=200):
        payload = json.dumps(value, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def handle_request(self):
        supplied = self.headers.get("Authorization", "")
        if not hmac.compare_digest(supplied, "Bearer " + TOKEN):
            return self.reply({"error": "Yetkisiz köprü isteği."}, 401)
        try:
            parsed = urllib.parse.urlsplit(self.path)
            path = urllib.parse.unquote(parsed.path)
            body = None
            if self.command in ("POST", "PUT", "PATCH", "DELETE"):
                length = int(self.headers.get("Content-Length", "0"))
                if length < 0 or length > 1024 * 1024:
                    raise BridgeError("İstek gövdesi çok büyük.", 413)
                if length:
                    if not self.headers.get("Content-Type", "").startswith("application/json"):
                        raise BridgeError("JSON içerik türü gerekli.", 415)
                    body = json.loads(self.rfile.read(length))
                    if not isinstance(body, dict):
                        raise BridgeError("JSON nesnesi gerekli.")
                else:
                    body = {}
            if self.command == "GET" and parsed.path in ("/state", "/snapshot"):
                return self.reply(state())
            if self.command == "POST" and parsed.path == "/power":
                return self.reply(power(body.get("action")))
            if self.command == "POST" and parsed.path == "/command":
                return self.reply(command(body.get("command")))
            if self.command == "POST" and parsed.path == "/mods":
                with LOCK, MOD_LOCK:
                    return self.reply(install_mod(body))
            if self.command == "DELETE" and re.fullmatch(r"/mods/(?:modrinth:|curseforge:)?[A-Za-z0-9_-]{1,80}", path):
                with LOCK, MOD_LOCK:
                    return self.reply(delete_mod(path.rsplit("/", 1)[1]))
            if parsed.path == "/chat" and self.command == "POST" or re.fullmatch(r"/players/[a-fA-F0-9-]{36}(?:/inventory)?", parsed.path) and self.command in ("GET", "PATCH", "PUT"):
                return self.reply(provider(self.path, self.command, body))
            raise BridgeError("Köprü yolu bulunamadı.", 404)
        except BridgeError as error:
            return self.reply({"error": str(error)}, error.status)
        except (ValueError, TypeError, json.JSONDecodeError):
            return self.reply({"error": "Geçersiz istek."}, 400)
        except Exception:
            return self.reply({"error": "Köprü işlemi tamamlanamadı; sunucu günlüğünü kontrol edin."}, 500)

    do_GET = handle_request
    do_POST = handle_request
    do_PUT = handle_request
    do_PATCH = handle_request
    do_DELETE = handle_request


class BoundedHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    capacity = threading.BoundedSemaphore(32)
    def process_request(self, request, client_address):
        if not self.capacity.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except Exception:
            self.capacity.release()
            raise
    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.capacity.release()


if __name__ == "__main__":
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,256}", TOKEN):
        sys.exit("SSP_BRIDGE_TOKEN en az 32 karakter olmalıdır. Anahtarı güvenli environment dosyasında saklayın.")
    if not ROOT.is_dir():
        sys.exit("SSP_SERVER_DIR mevcut bir dizin olmalıdır.")
    server = BoundedHTTPServer(("127.0.0.1", PORT), Handler)
    log("SSP köprüsü hazır. Otomatik sunucu başlatma kapalı.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        if running():
            try:
                power("stop")
            except BridgeError:
                pass
        server.server_close()
