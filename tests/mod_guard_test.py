import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec=importlib.util.spec_from_file_location('ssp_mod_guards',Path(__file__).parents[1]/'bridge/ssp_bridge.py')
bridge=importlib.util.module_from_spec(spec);spec.loader.exec_module(bridge)

class ModGuardTests(unittest.TestCase):
 def setUp(self):
  self.temp=tempfile.TemporaryDirectory();self.root=Path(self.temp.name)/'game';self.root.mkdir()
  self.context=patch.multiple(bridge,ROOT=self.root,LOADER='neoforge',VERSION='1.21.1',PROCESS=None)
  self.context.start();self.stopped=patch.object(bridge,'ensure_stopped',return_value=None);self.stopped.start()

 def tearDown(self): self.stopped.stop();self.context.stop();self.temp.cleanup()

 def jar(self,path,identity):
  with zipfile.ZipFile(path,'w') as jar:
   jar.writestr('META-INF/neoforge.mods.toml','modLoader="javafml"\n[[mods]]\nmodId="'+identity+'"\nversion="1"\n[[dependencies.'+identity+']]\nmodId="minecraft"\n')

 def record(self):
  return {'id':'modrinth:newproject','projectId':'newproject','name':'New mod','version':'2','versionId':'v2','author':'Fixture','description':'Fixture','enabled':True,'managed':True,'filename':'new-version.jar','hashAlgorithm':'sha512','hash':'a'*128,'provider':'modrinth','url':'https://cdn.modrinth.com/fixture.jar','dependencyRefs':[]}

 def test_manual_older_mod_with_same_loader_id_cannot_be_duplicated(self):
  folder=self.root/'mods';folder.mkdir();old=folder/'old-version.jar';self.jar(old,'shared_mod');before=old.read_bytes()
  with patch.object(bridge,'_resolve_modrinth',return_value=self.record()),patch.object(bridge,'_download_artifact',side_effect=lambda record,target,budget:self.jar(target,'shared_mod')):
   with self.assertRaisesRegex(bridge.BridgeError,'başka bir dosyası'):
    bridge.install_mod({'provider':'modrinth','projectId':'newproject'})
  self.assertEqual(old.read_bytes(),before);self.assertFalse((folder/'new-version.jar').exists());self.assertFalse((self.root/'.ssp-mods.json').exists())

 def test_shared_minecraft_dependency_is_not_mistaken_for_duplicate_mod_id(self):
  folder=self.root/'mods';folder.mkdir();self.jar(folder/'first.jar','first_mod')
  with patch.object(bridge,'_resolve_modrinth',return_value=self.record()),patch.object(bridge,'_download_artifact',side_effect=lambda record,target,budget:self.jar(target,'second_mod')):
   result=bridge.install_mod({'provider':'modrinth','projectId':'newproject'})
  self.assertEqual(result['id'],'modrinth:newproject');self.assertTrue((folder/'first.jar').exists());self.assertTrue((folder/'new-version.jar').exists())

 @unittest.skipUnless(os.name=='posix','Filesystem symlink permission differs on Windows; CI verifies this on Linux')
 def test_registry_and_mod_quarantine_symlinks_cannot_escape_game_scope(self):
  outside=Path(self.temp.name)/'outside';outside.mkdir();(outside/'keep.jar').write_bytes(b'keep')
  (self.root/'.ssp-mods.json').symlink_to(outside/'records.json');(outside/'records.json').write_text('{}','utf-8')
  with self.assertRaisesRegex(bridge.BridgeError,'sembolik'):bridge.registry()
  (self.root/'.ssp-mods.json').unlink();bridge.save_registry({'example':{'id':'example','filename':'keep.jar','name':'Fixture'}})
  (self.root/'mods').symlink_to(outside,target_is_directory=True)
  with self.assertRaisesRegex(bridge.BridgeError,'sembolik'):bridge.delete_mod('example')
  self.assertEqual((outside/'keep.jar').read_bytes(),b'keep')

if __name__=='__main__':unittest.main()
