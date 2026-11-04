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
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

TOKEN = os.environ.get("SSP_BRIDGE_TOKEN", "")
ROOT = Path(os.environ.get("SSP_SERVER_DIR", ".")).resolve()
VERSION = os.environ.get("SSP_GAME_VERSION", "1.21.4")
LOADER = os.environ.get("SSP_LOADER", "paper")
PLUGIN_URL = os.environ.get("SSP_PROVIDER_URL", "http://127.0.0.1:8787").rstrip("/")
PLUGIN_TOKEN = os.environ.get("SSP_PROVIDER_TOKEN", TOKEN)
PORT = int(os.environ.get("SSP_BRIDGE_PORT", "8765"))
USER_AGENT = "StylishServersPanel_SSP/0.1 (https://github.com/OpenMTLLC/StylishServersPanel_SSP)"
LOGS: deque[dict] = deque(maxlen=500)
LOG_LOCK = threading.RLock()
PROCESS: subprocess.Popen | None = None
STARTED = 0.0
LOCK = threading.RLock()
MOD_LOCK = threading.Lock()
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
    if not filename.exists():
        return {}
    try:
        data = json.loads(filename.read_text("utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        raise BridgeError("Mod kayıt dosyası okunamadı; işlem durduruldu.", 500) from None


def installed_mods():
    return list(registry().values())


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


def modrinth(path):
    request = urllib.request.Request("https://api.modrinth.com/v2" + path, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return json.loads(response.read(4 * 1024 * 1024))
    except (OSError, ValueError):
        raise BridgeError("Modrinth verileri alınamadı.", 502) from None


def install_mod(data):
    ensure_stopped()
    project_id = data.get("projectId", "")
    version_id = data.get("versionId")
    if not isinstance(project_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", project_id):
        raise BridgeError("Modrinth proje kimliği geçersiz.")
    if version_id is not None and (not isinstance(version_id, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", version_id)):
        raise BridgeError("Modrinth sürüm kimliği geçersiz.")
    project = modrinth("/project/" + project_id)
    loaders = ["paper", "spigot", "bukkit"] if LOADER == "paper" else [LOADER]
    if LOADER not in ("paper", "fabric", "forge", "neoforge"):
        raise BridgeError("Bu sunucu türü Modrinth JAR yüklemeyi desteklemiyor.", 409)
    query = urllib.parse.urlencode({"game_versions": json.dumps([VERSION]), "loaders": json.dumps(loaders)})
    versions = modrinth("/project/" + project_id + "/version?" + query)
    compatible = [v for v in versions if VERSION in v.get("game_versions", []) and set(loaders).intersection(v.get("loaders", [])) and v.get("version_type") == "release"]
    chosen = next((v for v in compatible if v.get("id") == version_id), None) if version_id else next(iter(compatible), None)
    if not chosen or project.get("server_side") == "unsupported":
        raise BridgeError("Sunucu sürümü ve yükleyicisiyle uyumlu kararlı sürüm bulunamadı.", 409)
    records = registry()
    if project["id"] in records:
        raise BridgeError("Bu proje zaten yüklü. Farklı sürüm için önce mevcut sürümü kaldırın.", 409)
    for dependency in chosen.get("dependencies", []):
        if dependency.get("dependency_type") == "required" and not any(r.get("id") == dependency.get("project_id") or r.get("versionId") == dependency.get("version_id") for r in records.values()):
            raise BridgeError("Önce gerekli bağımlılığı yükleyin: " + str(dependency.get("project_id") or dependency.get("version_id")), 409)
    files = [f for f in chosen.get("files", []) if f.get("filename", "").endswith(".jar")]
    artifact = next((f for f in files if f.get("primary")), None) or next(iter(files), None)
    if not artifact or not re.fullmatch(r"[A-Za-z0-9._+-]{1,180}\.jar", artifact.get("filename", "")):
        raise BridgeError("Güvenli bir JAR dosyası bulunamadı.")
    url = urllib.parse.urlsplit(artifact.get("url", ""))
    expected = artifact.get("hashes", {}).get("sha512", "")
    if url.scheme != "https" or url.hostname != "cdn.modrinth.com" or not re.fullmatch(r"[a-f0-9]{128}", expected):
        raise BridgeError("Mod indirme adresi veya SHA512 özeti doğrulanamadı.")
    directory = ROOT / ("plugins" if LOADER == "paper" else "mods")
    directory.mkdir(exist_ok=True)
    destination = directory / artifact["filename"]
    if destination.exists():
        raise BridgeError("Aynı adlı dosya var; üzerine yazılmadı. Önce mevcut sürümü kaldırın.", 409)
    temporary = directory / (artifact["filename"] + ".ssp-part")
    digest = hashlib.sha512()
    try:
        request = urllib.request.Request(artifact["url"], headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("xb") as target:
            if urllib.parse.urlsplit(response.url).hostname != "cdn.modrinth.com":
                raise BridgeError("Mod CDN yönlendirmesi reddedildi.")
            total = 0
            while block := response.read(65536):
                total += len(block)
                if total > 128 * 1024 * 1024:
                    raise BridgeError("Mod dosyası 128 MiB sınırını aşıyor.")
                digest.update(block)
                target.write(block)
        if not hmac.compare_digest(digest.hexdigest(), expected):
            raise BridgeError("Mod SHA512 özeti eşleşmiyor; dosya kurulmadı.")
        temporary.replace(destination)
    except OSError:
        raise BridgeError("Mod dosyası indirilemedi veya yazılamadı.", 502) from None
    finally:
        temporary.unlink(missing_ok=True)
    record = {"id": project["id"], "name": project["title"], "version": chosen["version_number"], "versionId": chosen["id"], "author": project.get("slug", "Modrinth"), "description": project.get("description", ""), "enabled": True, "filename": artifact["filename"], "sha512": expected, "provider": "modrinth"}
    records[record["id"]] = record
    save_registry(records)
    log("Mod yüklendi: " + record["name"] + " " + record["version"])
    return record


def delete_mod(mod_id):
    ensure_stopped()
    records = registry()
    record = records.get(mod_id)
    if not record:
        raise BridgeError("Yalnızca SSP üzerinden yüklenmiş modlar kaldırılabilir.", 404)
    filename = record.get("filename", "")
    if not re.fullmatch(r"[A-Za-z0-9._+-]{1,180}\.jar", filename):
        raise BridgeError("Mod dosya kaydı geçersiz.", 409)
    path = ROOT / ("plugins" if LOADER == "paper" else "mods") / filename
    # Move to quarantine instead of destroying a server administrator's artifact.
    if path.exists():
        quarantine = ROOT / ".ssp-removed"
        quarantine.mkdir(exist_ok=True)
        path.rename(quarantine / (str(time.time_ns()) + "-" + filename))
    del records[mod_id]
    save_registry(records)
    log("Mod kaldırıldı: " + record["name"])
    return {"removed": True}


class Handler(BaseHTTPRequestHandler):
    server_version = "SSPBridge/0.1"
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
            if self.command == "DELETE" and re.fullmatch(r"/mods/[A-Za-z0-9_-]{1,80}", parsed.path):
                with LOCK, MOD_LOCK:
                    return self.reply(delete_mod(parsed.path.rsplit("/", 1)[1]))
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
