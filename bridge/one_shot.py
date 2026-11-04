import contextlib
import io
import json
import os
from pathlib import Path
import re
import socket
import sys
import types


class OperationError(Exception):
    def __init__(self, message, status=409):
        self.status = status
        super().__init__(message)


def properties(directory):
    path = directory / 'server.properties'
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 1048576:
        raise OperationError('Minecraft sunucu dizini doğrulanamadı.')
    values = {}
    for line in path.read_text('utf-8', errors='replace').splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key, value = line.split('=', 1)
            if key.strip() in ('server-port', 'level-name'):
                values[key.strip()] = value.strip()
    return values


def listening(port, proc=Path('/proc')):
    for family in ('tcp', 'tcp6'):
        path = proc / 'net' / family
        try:
            lines = path.read_text('ascii').splitlines()[1:]
        except OSError:
            if family == 'tcp':
                raise OperationError('Açık oyun portları doğrulanamadı; mod dosyaları değiştirilmedi.') from None
            continue
        for line in lines:
            fields = line.split()
            if len(fields) > 3 and fields[3] == '0A':
                try:
                    if int(fields[1].rsplit(':', 1)[1], 16) == port:
                        return True
                except (ValueError, IndexError):
                    raise OperationError('Açık oyun portu bilgisi okunamadı.') from None
    return False


class StoppedGuard:
    """Keep real world file locks while a one-shot install is being committed."""
    def __init__(self, directory, discovery, proc=Path('/proc')):
        self.root = directory
        self.discovery = discovery
        self.proc = proc
        self.handles = []
        values = properties(directory)
        try:
            self.port = int(values.get('server-port', '25565'))
            if not 1 <= self.port <= 65535:
                raise ValueError()
        except ValueError:
            raise OperationError('Sunucu portu geçersiz.') from None
        level = (directory / values.get('level-name', 'world')).resolve()
        if not level.is_relative_to(directory):
            raise OperationError('Dünya dizini sunucu dizininin dışında; dosyalar değiştirilmedi.')
        self.world = level

    def check(self):
        if os.name != 'posix' or not self.proc.is_dir():
            raise OperationError('Mevcut sunucuda doğrudan mod yüklemek Linux SSH sunucusu gerektirir.')
        for process in self.discovery.java_processes(self.proc):
            if Path(process['directory']).resolve() == self.root:
                raise OperationError('Oyun sunucusu çalışıyor. Mod yüklemeden önce mevcut yöneticinizden durdurun.')
        if listening(self.port, self.proc):
            raise OperationError('Oyun portu açık. Mod yüklemeden önce sunucuyu durdurun.')

    def __enter__(self):
        self.check()
        import fcntl
        locks = set(self.root.glob('*/session.lock'))
        locks.add(self.world / 'session.lock')
        try:
            for path in sorted(locks):
                if not path.exists():
                    continue
                if path.is_symlink() or not path.resolve().is_relative_to(self.root):
                    raise OperationError('Dünya kilidi güvenli bir dosya değil.')
                handle = path.open('r+b')
                self.handles.append(handle)
                try:
                    fcntl.lockf(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
                except OSError:
                    raise OperationError('Minecraft dünya kilidi etkin; önce sunucuyu durdurun.') from None
            self.check()
            return self
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        for handle in self.handles:
            handle.close()
        self.handles.clear()


def execute(payload):
    if not isinstance(payload, dict):
        raise OperationError('Geçersiz mod işlemi.', 400)
    directory = payload.get('directory')
    if not isinstance(directory, str) or len(directory) > 4096 or any(x in directory for x in ('\0', '\r', '\n')):
        raise OperationError('Sunucu dizini geçersiz.', 400)
    root = Path(directory)
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise OperationError('Sunucu dizini mevcut ve mutlak olmalıdır.', 400)
    root = root.resolve()
    properties(root)
    loader = payload.get('loader')
    version = payload.get('gameVersion')
    if loader not in ('paper', 'fabric', 'forge', 'neoforge') or not isinstance(version, str) or not re.fullmatch(r'[A-Za-z0-9._-]{1,32}', version):
        raise OperationError('Sunucu yükleyicisi veya Minecraft sürümü belirlenemedi.', 400)
    operation = payload.get('operation')
    if operation not in ('install', 'remove'):
        raise OperationError('Mod işlemi geçersiz.', 400)
    source = payload.get('bridgeSource')
    discovery_source = payload.get('discoverySource')
    if not isinstance(source, str) or not isinstance(discovery_source, str):
        raise OperationError('SSP mod adaptörü bulunamadı.', 500)
    discovery = types.ModuleType('discover')
    discovery.__file__ = '<ssp-discovery>'
    # These sources are supplied by the panel installation, never HTTP client input.
    exec(compile(discovery_source, '<ssp-discovery>', 'exec'), discovery.__dict__)
    sys.modules['discover'] = discovery
    bridge = {'__name__': 'ssp_remote_operation', '__file__': '<ssp-bridge>'}
    exec(compile(source, '<ssp-bridge>', 'exec'), bridge)
    bridge['ROOT'] = root
    bridge['VERSION'] = version
    bridge['LOADER'] = loader
    bridge['PROCESS'] = None
    try:
        with StoppedGuard(root, discovery) as guard:
            bridge['ensure_stopped'] = guard.check
            if operation == 'install':
                data = {key: payload[key] for key in ('provider', 'projectId', 'versionId', 'fileId', 'apiKey') if key in payload}
                result = bridge['install_mod'](data)
            else:
                mod_id = payload.get('modId')
                if not isinstance(mod_id, str) or not re.fullmatch(r'(?:modrinth:|curseforge:)?[A-Za-z0-9_-]{1,100}', mod_id):
                    raise OperationError('Yönetilen mod kimliği geçersiz.', 400)
                result = bridge['delete_mod'](mod_id)
            mods = bridge['installed_mods']()
            return {'ok': True, 'result': result, 'mods': mods, 'source': 'ssh-one-shot'}
    except bridge['BridgeError'] as error:
        raise OperationError(str(error), getattr(error, 'status', 409)) from None


def main():
    try:
        payload = json.load(sys.stdin)
        # Helpers must not accidentally print request payload or credentials.
        with contextlib.redirect_stdout(io.StringIO()):
            value = execute(payload)
    except OperationError as error:
        value = {'error': str(error), 'status': error.status}
    except Exception:
        value = {'error': 'SSH üzerinden mod işlemi tamamlanamadı. Dizin izinlerini ve uyumluluğu kontrol edin.', 'status': 502}
    print(json.dumps(value, ensure_ascii=False))


if __name__ == '__main__':
    main()
