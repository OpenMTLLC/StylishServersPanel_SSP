import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('ssp_one_shot', Path(__file__).parents[1] / 'bridge' / 'one_shot.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

BRIDGE = '''
from pathlib import Path
class BridgeError(Exception):
 status=409
def install_mod(data):
 ensure_stopped()
 print(data.get('apiKey',''))
 folder=ROOT/'mods'
 folder.mkdir(exist_ok=True)
 (folder/'example.jar').write_bytes(b'new-mod')
 return {'id':data.get('provider','modrinth')+':example'}
def installed_mods():
 return [{'id':'curseforge:example','filename':'example.jar'}]
def delete_mod(mod_id):
 ensure_stopped()
 return {'removed':True}
'''
DISCOVERY = 'def java_processes(proc=None):\n return []\n'

class AllowStopped:
 def __init__(self,*_): self.checked=0
 def check(self): self.checked+=1
 def __enter__(self): return self
 def __exit__(self,*_): pass

class OneShotTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory()
  self.root=Path(self.temp.name).resolve()
  (self.root/'server.properties').write_text('server-port=25565\nlevel-name=world\n','utf-8')
  (self.root/'server.jar').write_bytes(b'existing-game-do-not-reinstall')

 def tearDown(self): self.temp.cleanup()

 def payload(self):
  return {'operation':'install','directory':str(self.root),'gameVersion':'1.21.1','loader':'neoforge','provider':'curseforge','projectId':'1','apiKey':'test-secret-never-echo','bridgeSource':BRIDGE,'discoverySource':DISCOVERY}

 def test_missing_game_marker_refuses_arbitrary_directory(self):
  (self.root/'server.properties').unlink()
  with self.assertRaisesRegex(module.OperationError,'doğrulanamadı'): module.execute(self.payload())

 def test_traversing_world_outside_game_directory_is_rejected(self):
  (self.root/'server.properties').write_text('level-name=../outside','utf-8')
  with self.assertRaisesRegex(module.OperationError,'dışında'):
   module.StoppedGuard(self.root,types.SimpleNamespace(java_processes=lambda _:[]))

 def test_listening_port_scan_distinguishes_listener_from_closed_socket(self):
  net=self.root/'net';net.mkdir()
  (net/'tcp').write_text('header\n 0: 0100007F:63DD 00000000:0000 0A 0 0\n 1: 0100007F:1234 00000000:0000 01 0 0\n','ascii')
  self.assertTrue(module.listening(25565,self.root))
  self.assertFalse(module.listening(4660,self.root))

 def test_nonlinux_host_cannot_claim_stopped_server(self):
  guard=module.StoppedGuard(self.root,types.SimpleNamespace(java_processes=lambda _:[]),proc=self.root/'missing-proc')
  with self.assertRaisesRegex(module.OperationError,'Linux'): guard.check()

 def test_existing_game_survives_one_shot_install_and_api_key_is_not_printed(self):
  output=io.StringIO()
  with patch.object(module,'StoppedGuard',AllowStopped),patch.object(module.sys,'stdin',io.StringIO(json.dumps(self.payload()))),patch('sys.stdout',output):
   module.main()
  response=json.loads(output.getvalue())
  self.assertTrue(response['ok'])
  self.assertEqual(response['source'],'ssh-one-shot')
  self.assertEqual((self.root/'server.jar').read_bytes(),b'existing-game-do-not-reinstall')
  self.assertEqual((self.root/'mods/example.jar').read_bytes(),b'new-mod')
  self.assertNotIn('test-secret-never-echo',output.getvalue())

 def test_removal_rejects_unmanaged_path_traversal(self):
  payload=self.payload();payload.update(operation='remove',modId='../../server.jar')
  with patch.object(module,'StoppedGuard',AllowStopped):
   with self.assertRaisesRegex(module.OperationError,'kimliği'): module.execute(payload)
  self.assertTrue((self.root/'server.jar').exists())

if __name__=='__main__': unittest.main()
