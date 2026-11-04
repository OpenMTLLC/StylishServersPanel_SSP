import importlib.util
import json
import hashlib
import os
from pathlib import Path
import tempfile
import sys
import time
import threading
import unittest
from unittest.mock import patch
import urllib.request
import urllib.error

spec = importlib.util.spec_from_file_location("ssp_bridge", Path(__file__).parents[1] / "bridge" / "ssp_bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = patch.object(bridge, "ROOT", Path(self.temp.name))
        self.root.start()
        self.process = patch.object(bridge, "PROCESS", None)
        self.process.start()
        self.provider = patch.object(bridge, "provider", side_effect=bridge.BridgeError("not connected", 503))
        self.provider.start()

    def tearDown(self):
        self.provider.stop()
        self.process.stop()
        self.root.stop()
        self.temp.cleanup()

    def test_real_child_process_starts_receives_console_and_stops_gracefully(self):
        program = Path(self.temp.name) / "fake_game.py"
        program.write_text("import sys\nprint('ready', flush=True)\nfor line in sys.stdin:\n if line.strip() == 'stop': break\n print(line.strip(), flush=True)\n", encoding="utf-8")
        executable = sys.executable.replace("\\", "/")
        with patch.dict(os.environ, {"SSP_START_COMMAND": f'"{executable}" -u fake_game.py'}):
            try:
                self.assertEqual(bridge.power("start")["status"], "running")
                child = bridge.PROCESS
                self.assertEqual(bridge.command("say lifecycle-check"), {"accepted": True})
                self.assertEqual(bridge.power("stop")["status"], "stopped")
                self.assertEqual(child.poll(), 0)
                deadline = time.monotonic() + 2
                while time.monotonic() < deadline and not any("lifecycle-check" in line["message"] for line in bridge.LOGS):
                    time.sleep(0.01)
                self.assertTrue(any("lifecycle-check" in line["message"] for line in bridge.LOGS))
                child.stdin.close()
                child.stdout.close()
            finally:
                if bridge.running():
                    bridge.power("stop")

    def test_console_is_not_shell_and_rejects_multi_line(self):
        with self.assertRaisesRegex(bridge.BridgeError, "tek satır"):
            bridge.command("say hello\nstop")
        with self.assertRaisesRegex(bridge.BridgeError, "başlatılmalıdır"):
            bridge.command("say $(whoami)")

    def test_provider_connection_blocks_mod_write_even_if_process_is_external(self):
        with patch.object(bridge, "provider", return_value={"status": "running"}):
            with self.assertRaisesRegex(bridge.BridgeError, "başka bir süreçte"):
                bridge.install_mod({"projectId": "fabric-api"})

    def test_invalid_project_rejected_before_any_network_request(self):
        with patch.object(bridge, "modrinth") as metadata:
            with self.assertRaisesRegex(bridge.BridgeError, "kimliği geçersiz"):
                bridge.install_mod({"projectId": "../../credentials"})
            metadata.assert_not_called()

    def test_untracked_removal_cannot_delete_arbitrary_file(self):
        secret = Path(self.temp.name) / "secret.txt"
        secret.write_text("keep")
        with self.assertRaisesRegex(bridge.BridgeError, "SSP üzerinden"):
            bridge.delete_mod("../../secret.txt")
        self.assertTrue(secret.exists())

    def test_known_mod_removal_moves_jar_to_quarantine(self):
        directory = Path(self.temp.name) / "plugins"
        directory.mkdir()
        (directory / "example.jar").write_bytes(b"plugin")
        bridge.save_registry({"project": {"id": "project", "name": "Example", "filename": "example.jar"}})
        self.assertEqual(bridge.delete_mod("project"), {"removed": True})
        self.assertFalse((directory / "example.jar").exists())
        self.assertEqual(len(list((Path(self.temp.name) / ".ssp-removed").iterdir())), 1)
        self.assertEqual(bridge.registry(), {})

    def test_loopback_api_requires_bearer_and_never_returns_secrets(self):
        with patch.object(bridge, "TOKEN", "a" * 64):
            server = bridge.ThreadingHTTPServer(("127.0.0.1", 0), bridge.Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = "http://127.0.0.1:%s/state" % server.server_port
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url)
                self.assertEqual(error.exception.code, 401)
                request = urllib.request.Request(url, headers={"Authorization": "Bearer " + "a" * 64})
                with urllib.request.urlopen(request) as response:
                    data = json.load(response)
                self.assertEqual(data["status"], "stopped")
                self.assertFalse(data["providerConnected"])
                self.assertNotIn("a" * 64, json.dumps(data))
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def graph_record(self, project, dependencies=()):
        return {"id": "modrinth:" + project, "projectId": project, "name": project, "version": "1", "versionId": "v-" + project, "filename": project + ".jar", "hashAlgorithm": "sha512", "hash": hashlib.sha512(project.encode()).hexdigest(), "provider": "modrinth", "url": "https://cdn.modrinth.com/" + project, "managed": True, "dependencyRefs": list(dependencies)}

    def test_required_dependencies_auto_install_in_single_transaction(self):
        def resolve(project, version):
            return self.graph_record(project, [("library", None)] if project == "main" else [])
        def download(record, target, budget):
            target.write_bytes(record["projectId"].encode())
        with patch.object(bridge, "_resolve_modrinth", side_effect=resolve), patch.object(bridge, "_download_artifact", side_effect=download):
            result = bridge.install_mod({"projectId": "main"})
        self.assertEqual(len(result["installed"]), 2)
        self.assertTrue((Path(self.temp.name) / "plugins/main.jar").exists())
        self.assertTrue((Path(self.temp.name) / "plugins/library.jar").exists())
        self.assertEqual(bridge.registry()["modrinth:main"]["dependencies"], ["modrinth:library"])
        with self.assertRaisesRegex(bridge.BridgeError, "bağımlı"):
            bridge.delete_mod("modrinth:library")

    def test_failed_dependency_verification_commits_nothing(self):
        def resolve(project, version):
            return self.graph_record(project, [("library", None)] if project == "main" else [])
        def download(record, target, budget):
            if record["projectId"] == "library":
                raise bridge.BridgeError("dosya özeti eşleşmiyor")
            target.write_bytes(b"main")
        with patch.object(bridge, "_resolve_modrinth", side_effect=resolve), patch.object(bridge, "_download_artifact", side_effect=download):
            with self.assertRaisesRegex(bridge.BridgeError, "özeti"):
                bridge.install_mod({"projectId": "main"})
        self.assertFalse(list(Path(self.temp.name).glob("plugins/*.jar")))
        self.assertFalse((Path(self.temp.name) / ".ssp-mods.json").exists())
        self.assertFalse(list(Path(self.temp.name).glob(".ssp-stage-*")))

    def test_commit_failure_rolls_back_every_new_jar(self):
        original_link = bridge.os.link
        calls = []
        def link(source, destination):
            calls.append(destination)
            if len(calls) == 2:
                raise OSError("fixture write failure")
            original_link(source, destination)
        with patch.object(bridge, "_resolve_modrinth", side_effect=lambda project, version: self.graph_record(project, [("dep", None)] if project == "main" else [])), patch.object(bridge, "_download_artifact", side_effect=lambda record, target, budget: target.write_bytes(b"jar")), patch.object(bridge.os, "link", side_effect=link):
            with self.assertRaisesRegex(bridge.BridgeError, "geri alındı"):
                bridge.install_mod({"projectId": "main"})
        self.assertEqual(len(calls), 2)
        self.assertFalse(list(Path(self.temp.name).glob("plugins/*.jar")))
        self.assertFalse((Path(self.temp.name) / ".ssp-mods.json").exists())

    def test_server_started_during_download_blocks_commit(self):
        with patch.object(bridge, "ensure_stopped", side_effect=[None, bridge.BridgeError("server started", 409)]), patch.object(bridge, "_resolve_modrinth", return_value=self.graph_record("main")), patch.object(bridge, "_download_artifact", side_effect=lambda record, target, budget: target.write_bytes(b"jar")):
            with self.assertRaisesRegex(bridge.BridgeError, "server started"):
                bridge.install_mod({"projectId": "main"})
        self.assertFalse(list(Path(self.temp.name).glob("plugins/*.jar")))

    def test_curseforge_author_denial_and_missing_download_url_are_respected(self):
        with patch.object(bridge, "LOADER", "neoforge"), patch.object(bridge, "curseforge", return_value={"id": 123, "allowModDistribution": False}):
            with self.assertRaisesRegex(bridge.BridgeError, "dağıtımını kapatmış"):
                bridge._resolve_curseforge("123", None, "PRIVATE_KEY")
        project = {"id": 123, "gameId": 432, "classId": 6, "name": "Example", "allowModDistribution": True}
        file = {"id": 456, "modId": 123, "releaseType": 1, "gameVersions": [bridge.VERSION, "NeoForge"], "downloadUrl": None}
        with patch.object(bridge, "LOADER", "neoforge"), patch.object(bridge, "curseforge", side_effect=[project, [file]]):
            with self.assertRaisesRegex(bridge.BridgeError, "indirmeye kapalı"):
                bridge._resolve_curseforge("123", None, "PRIVATE_KEY")

    def test_curseforge_key_never_enters_registry_or_result(self):
        key = "PRIVATE_CURSEFORGE_KEY"
        record = self.graph_record("123")
        record.update(id="curseforge:123", provider="curseforge", hashAlgorithm="sha1", hash="a" * 40)
        with patch.object(bridge, "_resolve_curseforge", return_value=record) as resolver, patch.object(bridge, "_download_artifact", side_effect=lambda record, target, budget: target.write_bytes(b"jar")):
            result = bridge.install_mod({"provider": "curseforge", "projectId": "123", "apiKey": key})
        resolver.assert_called_once_with("123", None, key)
        self.assertNotIn(key, json.dumps(result))
        self.assertNotIn(key, (Path(self.temp.name) / ".ssp-mods.json").read_text())
        self.assertNotIn(key, json.dumps(list(bridge.LOGS)))

    def test_cdn_redirect_cannot_leave_provider_domain(self):
        self.assertTrue(bridge.allowed_cdn("https://edge.forgecdn.net/files/a.jar", "curseforge"))
        self.assertFalse(bridge.allowed_cdn("https://forgecdn.net.evil.example/a.jar", "curseforge"))
        with self.assertRaisesRegex(bridge.BridgeError, "yönlendirmesi"):
            bridge.CDNRedirect("curseforge").redirect_request(None, None, 302, "", {}, "https://evil.example/a.jar")


if __name__ == "__main__":
    unittest.main()
