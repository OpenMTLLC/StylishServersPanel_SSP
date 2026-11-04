import importlib.util
import json
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


if __name__ == "__main__":
    unittest.main()
