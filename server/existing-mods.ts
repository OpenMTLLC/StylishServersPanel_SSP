import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {runSshPython, type SshConfig} from './adapters.js';

export interface ExistingModOptions {
  directory: string;
  gameVersion: string;
  loader: string;
  provider?: 'modrinth' | 'curseforge';
  projectId?: string;
  versionId?: string;
  fileId?: number;
  apiKey?: string;
  modId?: string;
}

async function existingOperation(connection:SshConfig, operation:'install'|'remove', options:ExistingModOptions) {
  if (!options.directory?.startsWith('/') || options.directory.length > 4096 || /[\x00\r\n]/.test(options.directory)) throw new Error('Sunucu dizini geçersiz.');
  if (!['paper','fabric','forge','neoforge'].includes(options.loader) || !/^[a-zA-Z0-9._-]{1,32}$/.test(options.gameVersion)) throw new Error('Sunucu yükleyicisi ve Minecraft sürümü doğrulanmalıdır.');
  const [script,bridgeSource,discoverySource] = await Promise.all([
    readFile(resolve('bridge/one_shot.py'),'utf8'),
    readFile(resolve('bridge/ssp_bridge.py'),'utf8'),
    readFile(resolve('bridge/discover.py'),'utf8'),
  ]);
  const result = await runSshPython(connection,script,{...options,operation,bridgeSource,discoverySource},360000);
  if (result?.error) throw new Error(String(result.error).slice(0,300));
  if (!result?.ok || !Array.isArray(result.mods)) throw new Error('Uzak mod işlemi geçerli sonuç döndürmedi.');
  return result as {ok:true;result:any;mods:any[];source:'ssh-one-shot'};
}
export function installExistingMods(connection:SshConfig,options:ExistingModOptions) { return existingOperation(connection,'install',options); }
export function removeExistingMod(connection:SshConfig,options:ExistingModOptions) { return existingOperation(connection,'remove',options); }
