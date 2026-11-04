import importlib.util
import json
from pathlib import Path
import socket
import tempfile
import threading
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("ssp_discover", Path(__file__).parents[1] / "bridge" / "discover.py")
discovery = importlib.util.module_from_spec(spec)
spec.loader.exec_module(discovery)


class DiscoveryTests(unittest.TestCase):
    def test_neoforge_fixture_read_only_ram_and_unique_players_are_authoritative(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            root = home / "game"
            root.mkdir()
            (root / "server.properties").write_text("server-port=25565\nmax-players=40\nlevel-name=world\nrcon.password=PRIVATE_DO_NOT_RETURN\n")
            (root / "run.sh").write_text("DO_NOT_EXECUTE; touch forbidden-file\njava @user_jvm_args.txt @libraries/net/neoforged/neoforge/21.1.209/unix_args.txt\n")
            (root / "user_jvm_args.txt").write_text("-Xmx6G\n")
            (root / "libraries/net/neoforged/neoforge/21.1.209").mkdir(parents=True)
            (root / "world/playerdata").mkdir(parents=True)
            (root / "world/stats").mkdir(parents=True)
            first = "11111111-1111-4111-8111-111111111111"
            second = "22222222-2222-4222-8222-222222222222"
            never_joined = "33333333-3333-4333-8333-333333333333"
            (root / "world/playerdata" / (first + ".dat")).write_bytes(b"opaque-nbt-not-read")
            (root / "world/stats" / (first + ".json")).write_text("{}")
            (root / "world/stats" / (second + ".json")).write_text("{}")
            (root / "usercache.json").write_text(json.dumps([{"uuid": first}, {"uuid": never_joined}]))
            (root / "mods").mkdir()
            with zipfile.ZipFile(root / "mods/example.jar", "w") as jar:
                jar.writestr("META-INF/neoforge.mods.toml", 'modLoader="javafml"\n[[mods]]\nmodId="example"\ndisplayName="Example Mod"\nversion="1.2.3"\n')
            (root / ".ssp-mods.json").write_text(json.dumps({"curseforge:123": {"id": "curseforge:123", "name": "Managed Example", "filename": "example.jar", "provider": "curseforge", "managed": True, "apiKey": "PRIVATE_KEY"}}))
            before = {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) for path in root.rglob("*") if path.is_file()}
            processes = discovery.ProcessList([{"directory": str(root), "args": ["@user_jvm_args.txt"], "memory": 0.75}])
            with patch.object(discovery, "java_processes", return_value=processes), patch.object(discovery, "status_ping", return_value={"players": {"online": 4, "max": 40}, "version": {"name": "NeoForge 1.21.1"}}):
                report = discovery.discover({"directory": str(root)}, home=home)
            server = report["candidates"][0]
            self.assertEqual(server["edition"], "neoforge")
            self.assertEqual(server["version"], "1.21.1")
            self.assertEqual(server["playersOnline"], 4)
            self.assertEqual(server["playersTotal"], 2)
            self.assertEqual(server["playersTotalSource"], "world-history")
            self.assertEqual(server["metrics"]["memoryTotal"], 6)
            self.assertEqual(server["metrics"]["allocatedMemoryMb"], 6144)
            self.assertEqual(server["metrics"]["memory"], 0.75)
            self.assertEqual(server["mods"][0]["id"], "curseforge:123")
            self.assertTrue(server["mods"][0]["managed"])
            self.assertIsNone(server["loadedMods"])
            self.assertNotIn("PRIVATE_", json.dumps(report))
            after = {str(path.relative_to(root)): (path.read_bytes(), path.stat().st_mtime_ns) for path in root.rglob("*") if path.is_file()}
            self.assertEqual(before, after)
            self.assertFalse((root / "forbidden-file").exists())

    def test_unknown_is_not_faked_as_zero_or_stopped(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / "server.properties").write_text("server-port=25565\n")
            incomplete = discovery.ProcessList()
            incomplete.complete = False
            with patch.object(discovery, "status_ping", return_value=None):
                server = discovery.inspect_directory(root, incomplete, {"ramGb": 16})
            self.assertEqual(server["status"], "unknown")
            self.assertIsNone(server["running"])
            self.assertIsNone(server["playersOnline"])
            self.assertIsNone(server["playersTotal"])
            self.assertIsNone(server["metrics"]["memoryTotal"])
            self.assertEqual(server["metrics"]["machineMemoryTotal"], 16)

    def test_status_protocol_reads_real_local_packet_without_game_provider(self):
        listener = socket.socket()
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        payload = json.dumps({"players": {"online": 7, "max": 20}, "version": {"name": "1.21.1"}}).encode()
        errors = []
        def serve():
            try:
                client, _ = listener.accept()
                with client:
                    client.settimeout(2)
                    size = discovery.read_varint(client)
                    discovery.recv_exact(client, size)
                    self.assertEqual(discovery.recv_exact(client, 2), b"\x01\x00")
                    packet = b"\x00" + discovery.varint(len(payload)) + payload
                    client.sendall(discovery.varint(len(packet)) + packet)
            except Exception as error:
                errors.append(error)
        thread = threading.Thread(target=serve, daemon=True)
        thread.start()
        try:
            self.assertEqual(discovery.status_ping(port)["players"]["online"], 7)
        finally:
            thread.join(timeout=3)
            listener.close()
        self.assertFalse(errors)


if __name__ == "__main__":
    unittest.main()
