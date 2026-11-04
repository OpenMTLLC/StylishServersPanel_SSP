import { useEffect, useState, type FormEvent } from 'react';
import { ArrowRight, Check, CheckCheck, Download, Fingerprint, Gamepad2, Link2, LoaderCircle, Play, RefreshCw, Search, Server, ShieldCheck, Terminal, Wifi, X, Zap } from 'lucide-react';
import DiscoverySummary, { type Inspection, type DiscoveredServer } from './DiscoverySummary';
import { Modal } from './App';

type Game = 'minecraft' | 'valheim' | 'terraria' | 'rust';
type Stage = 'choice' | 'software' | 'connection' | 'review' | 'setup' | 'install';
type Api = <T>(path: string, method?: string, body?: unknown) => Promise<T>;
const games: Record<Game, string> = { minecraft: 'Minecraft', valheim: 'Valheim', terraria: 'Terraria', rust: 'Rust' };
const stageNames: Record<Stage, string> = { choice: 'Başlangıç', software: 'Yeni sunucu', connection: 'SSH bağlantısı', review: 'Mevcut sunucu', setup: 'Kurulum', install: 'Kurulum günlüğü' };

export default function ServerWizard({ api, initialHost, onClose, onCreated, notify }: { api: Api; initialHost: string; onClose: () => void; onCreated: (id: string) => void; notify: (message: string, error?: boolean) => void }) {
 const [stage, setStage] = useState<Stage>('choice');
 const [installed, setInstalled] = useState(true), [name, setName] = useState(''), [game, setGame] = useState<Game>('minecraft'), [edition, setEdition] = useState('neoforge'), [version, setVersion] = useState('1.21.1');
 const [host, setHost] = useState(initialHost), [port, setPort] = useState(22), [username, setUsername] = useState(''), [authMethod, setAuthMethod] = useState<'password'|'key'>('password'), [password, setPassword] = useState(''), [privateKey, setPrivateKey] = useState('');
 const [fingerprint, setFingerprint] = useState(''), [fingerprintConfirmed, setFingerprintConfirmed] = useState(false), [probe, setProbe] = useState<any>(null), [directory, setDirectory] = useState('');
 const [scan, setScan] = useState<Inspection | null>(null), [candidateDirectory, setCandidateDirectory] = useState('');
 const [installMode, setInstallMode] = useState('auto'), [eula, setEula] = useState(false), [bridgePort, setBridgePort] = useState(''), [bridgeUrl, setBridgeUrl] = useState(''), [bridgeToken, setBridgeToken] = useState('');
 const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState<any>(null), [install, setInstall] = useState<any>(null);
 const connection = { host, port, username, ...(authMethod === 'password' ? { password } : { privateKey }), hostFingerprint: fingerprint };
 const candidates = scan?.candidates || [];
 const candidate = candidates.find(c => c.directory === candidateDirectory) || (scan?.directory ? scan as DiscoveredServer : null);
 function invalidateHost() { setProbe(null); setFingerprintConfirmed(false); setScan(null); }
 function move(next: Stage) { setError(''); setStage(next); }
 async function probeConnection() {
  setBusy(true); setError('');
  try { const value = await api<any>('/api/connections/probe', 'POST', connection); setProbe(value); if (value.fingerprint) setFingerprint(value.fingerprint); setFingerprintConfirmed(false); }
  catch (e) { setError((e as Error).message); }
  finally { setBusy(false); }
 }
 async function inspect() {
  if (!fingerprintConfirmed) { setError('SSH parmak izini bağımsız bir kaynaktan doğrulayıp onayla.'); return; }
  setBusy(true); setError('');
  try {
   const value = await api<Inspection>('/api/connections/inspect', 'POST', { connection, ...(directory.trim() ? { directory: directory.trim() } : {}) });
   const found = value.candidates || (value.directory ? [value as DiscoveredServer] : []);
   setScan({ ...value, candidates: found });
   setCandidateDirectory(found.length === 1 ? found[0].directory : '');
   if (found.length === 1 && !name) setName(found[0].directory.split('/').filter(Boolean).pop() || 'Mevcut sunucum');
   move('review');
  } catch (e) { setError((e as Error).message); }
  finally { setBusy(false); }
 }
 async function submit(event: FormEvent) {
  event.preventDefault(); setError('');
  if (stage === 'choice') { move(installed ? 'connection' : 'software'); return; }
  if (stage === 'software') { move('connection'); return; }
  if (stage === 'connection') { if (installed) await inspect(); else if (fingerprintConfirmed) move('setup'); return; }
  if (stage !== 'review' && stage !== 'setup') return;
  if (installed && !candidate) { setError('Panele eklenecek sunucu dizinini seç.'); return; }
  setBusy(true);
  try {
   const body = installed
    ? { installed: true, name: name.trim() || 'Mevcut sunucum', connection, directory: candidate!.directory }
    : { name, game, edition, version, connection, installed: false, installMode, eulaAccepted: eula, ...(bridgePort ? { bridgePort: Number(bridgePort) } : {}), ...(bridgeUrl ? { bridgeUrl } : {}), ...(bridgeToken ? { bridgeToken } : {}) };
   const value = await api<any>('/api/servers', 'POST', body);
   const id = value.server?.id || value.id || value.serverId;
   if (installed) { onCreated(id); return; }
   setResult({ ...value, id });
   setInstall(await api<any>(`/api/servers/${id}/install`));
   move('install');
  } catch (e) { setError((e as Error).message); }
  finally { setBusy(false); }
 }
 async function retryInstall() {
  setBusy(true); setError('');
  try { setInstall(await api(`/api/servers/${result.id}/install`, 'POST', { eulaAccepted: eula })); notify('Kurulum isteği gönderildi.'); }
  catch (e) { setError((e as Error).message); }
  finally { setBusy(false); }
 }
 useEffect(() => {
  if (stage !== 'install' || !result?.id || installMode !== 'auto') return;
  const timer = setInterval(() => { api(`/api/servers/${result.id}/install`).then(setInstall).catch(() => {}); }, 3000);
  return () => clearInterval(timer);
 }, [stage, result?.id, api, installMode]);
 const stageLabels = installed ? ['Başlangıç', 'SSH bağlantısı', 'Mevcut sunucu'] : ['Başlangıç', 'Yeni sunucu', 'SSH bağlantısı', 'Kurulum'];
 const step = stageLabels.indexOf(stageNames[stage]);
 return <Modal title={stage === 'install' ? 'Kurulum merkezi' : installed && stage === 'review' ? 'Mevcut sunucunu doğrudan bağla' : 'Sunucunu SSP’ye bağla'} subtitle={installed ? 'Var olan dosyalar ve ayarlar korunur. Önce salt okunur bir SSH taraması yapılır.' : 'Yeni sunucun için oyun yazılımını ve kurulum yöntemini seç.'} onClose={onClose} wide>
  <div className="wizard-steps">{stageLabels.map((label, i) => <div key={label} className={i <= step || stage === 'install' ? 'active' : ''}><span>{i < step || stage === 'install' ? <Check size={14}/> : i + 1}</span>{label}{i < stageLabels.length - 1 && <i/>}</div>)}</div>
  {error && <div className="notice error" role="alert">{error}</div>}
  <form onSubmit={submit} className="form-stack">
   {stage === 'choice' && <>
    <p className="wizard-choice-intro">Bağlayacağın oyun sunucusu şu an hazır kurulu mu?</p>
    <div className="setup-options"><button type="button" className={installed ? 'active' : ''} onClick={() => setInstalled(true)}><CheckCheck size={25}/><strong>Evet, mevcut sunucumu bağlayacağım</strong><span>SSH ile bağlan, sunucuyu ve mevcut verilerini tara, doğrudan panele geç.</span></button><button type="button" className={!installed ? 'active' : ''} onClick={() => setInstalled(false)}><Download size={25}/><strong>Hayır, yeni sunucu kuracağım</strong><span>Oyun türü, yazılım ve sürümünü seçerek yeni bir kurulum hazırla.</span></button></div>
    <div className="permission-note"><ShieldCheck size={20}/><p>Mevcut sunucu akışı oyun yazılımı yüklemez, EULA ayarını değiştirmez ve var olan kurulumun üzerine yazmaz.</p></div>
   </>}
   {stage === 'software' && <>
    <label>Sunucu adı<input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="Örn. NeoForge Macera Sunucum" required maxLength={80}/></label>
    <label>Oyun türü</label><div className="game-options">{(Object.keys(games) as Game[]).map(value => <button type="button" key={value} className={game === value ? 'active' : ''} onClick={() => { setGame(value); setEdition(value === 'minecraft' ? 'neoforge' : 'vanilla'); setVersion(value === 'minecraft' ? '1.21.1' : 'latest'); }}><Gamepad2 size={25}/><strong>{games[value]}</strong>{game === value && <Check size={15}/>}</button>)}</div>
    <div className="form-grid"><label>Sunucu yazılımı<select value={edition} onChange={e => setEdition(e.target.value)}>{(game === 'minecraft' ? ['neoforge','forge','fabric','paper','vanilla'] : ['vanilla']).map(value => <option key={value} value={value}>{value === 'neoforge' ? 'NeoForge' : value[0].toUpperCase() + value.slice(1)}</option>)}</select></label><label>Oyun sürümü<input value={version} onChange={e => setVersion(e.target.value)} required maxLength={32} placeholder="1.21.1"/></label></div>
    <p className="field-help">NeoForge, Forge ve Fabric modları kendi yükleyicileriyle eşleştirilir. Kurulum seçilen sürüme göre hazırlanır.</p>
   </>}
   {stage === 'connection' && <>
    <div className="form-grid wide-first"><label>SSH giriniz<input autoFocus value={host} onChange={e => { setHost(e.target.value); invalidateHost(); }} placeholder="Sunucu IP adresi veya alan adı" required maxLength={253}/></label><label>Port<input type="number" value={port} onChange={e => { setPort(Number(e.target.value)); invalidateHost(); }} min={1} max={65535} required/></label></div>
    <label>SSH kullanıcısı<input value={username} onChange={e => setUsername(e.target.value)} placeholder="Sunucu kullanıcı adın" required maxLength={64}/></label>
    <div className="filter-tabs"><button type="button" className={authMethod === 'password' ? 'active' : ''} onClick={() => setAuthMethod('password')}>Parola</button><button type="button" className={authMethod === 'key' ? 'active' : ''} onClick={() => setAuthMethod('key')}>Özel anahtar</button></div>
    {authMethod === 'password' ? <label>SSH parolası<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="new-password" required/></label> : <label>SSH özel anahtarı<textarea value={privateKey} onChange={e => setPrivateKey(e.target.value)} rows={4} required placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"/></label>}
    {installed && <label>Mevcut sunucu dizini <span className="field-optional">İsteğe bağlı; boşsa sunucular aranır</span><input value={directory} onChange={e => setDirectory(e.target.value)} placeholder="Örn. /home/ssp/minecraft" maxLength={512}/></label>}
    <div className="probe-row"><button className="button secondary" type="button" disabled={busy || !host || !username || !(authMethod === 'password' ? password : privateKey)} onClick={probeConnection}>{busy ? <LoaderCircle size={17} className="spin"/> : <Wifi size={17}/>} SSH bağlantısını kontrol et</button>{probe && <span className="wizard-inline-status">{probe.verified ? 'Parmak izi eşleşti.' : 'Parmak izi alındı; bağımsız doğrulama gerekli.'}</span>}</div>
    <label>Sunucu anahtar parmak izi<input value={fingerprint} onChange={e => { setFingerprint(e.target.value); setFingerprintConfirmed(false); }} placeholder="SHA256:…" required maxLength={128}/></label>
    <label className="check-label"><input type="checkbox" checked={fingerprintConfirmed} required onChange={e => setFingerprintConfirmed(e.target.checked)}/><span>Bu SSH parmak izini sunucu sağlayıcımdan veya bağımsız bir kaynaktan doğruladım.</span></label>
    {installed && <div className="permission-note"><Search size={20}/><p>Sonraki adım yalnızca mevcut sunucuları, RAM ve disk bilgisini, oyuncu kayıtlarını ve mod dosyalarını okur. Sunucuda kurulum yapılmaz.</p></div>}
   </>}
   {stage === 'review' && <>
    {candidates.length === 0 ? <><div className="notice">Bu SSH kullanıcısının erişebildiği dizinlerde desteklenen bir sunucu bulunamadı. Mevcut sunucunun dizinini girerek yeniden tara.</div>{scan?.warnings?.length ? <div className="discovery-warnings"><h4>Tarama notları</h4><ul>{scan.warnings.map((w, i) => <li key={i}>{w}</li>)}</ul></div> : null}</> : <>
     <label>Bulunan sunucu<select required value={candidateDirectory} onChange={e => { setCandidateDirectory(e.target.value); if (!name) setName(e.target.value.split('/').filter(Boolean).pop() || 'Mevcut sunucum'); }}><option value="">{candidates.length > 1 ? `${candidates.length} sunucu bulundu; eklenecek dizini seç` : 'Sunucu dizinini seç'}</option>{candidates.map(c => <option value={c.directory} key={c.directory}>{c.directory} · {c.edition || 'Yazılım bilinmiyor'} {c.version || ''}</option>)}</select></label>
     {candidate && <><label>Panelde gösterilecek sunucu adı<input value={name} onChange={e => setName(e.target.value)} required maxLength={80} placeholder="Mevcut sunucum"/></label><DiscoverySummary server={candidate} scan={scan || undefined}/><p className="field-help">Kaynak: salt okunur SSH taraması · {scan?.observedAt ? new Date(scan.observedAt).toLocaleString('tr-TR') : 'Tarama zamanı sağlanmadı'}. “—” doğrulanamayan bilgiyi belirtir.</p><div className="permission-note"><CheckCheck size={20}/><p>Bu sunucu hazır kurulu olarak içe aktarılacak. Oyun türü ve yazılımı yeniden seçmen gerekmez. İçe aktarımda seçili dizin sunucu tarafında tekrar doğrulanır.</p></div></>}
    </>}
   </>}
   {stage === 'setup' && <>
    <h3 className="wizard-question">Yeni sunucun nasıl kurulsun?</h3><div className="setup-options"><button type="button" className={installMode === 'auto' ? 'active' : ''} onClick={() => setInstallMode('auto')}><Zap size={24}/><strong>Otomatik kurulum</strong><span>Seçilen oyun sunucusu ve SSP köprüsü SSH üzerinden kurulur.</span></button><button type="button" className={installMode === 'manual' ? 'active' : ''} onClick={() => setInstallMode('manual')}><Terminal size={24}/><strong>Manuel kurulum</strong><span>Hazırlanan komutları inceleyip kendin çalıştırırsın.</span></button></div>
    {game === 'minecraft' && <label className="check-label"><input type="checkbox" checked={eula} onChange={e => setEula(e.target.checked)} required/><span><a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">Minecraft EULA</a> koşullarını okudum ve kabul ediyorum.</span></label>}
    <div className="bridge-form"><div><Link2 size={19}/><strong>Oyun köprüsü bağlantısı</strong><span className="tag">GELİŞMİŞ</span></div><p>Otomatik kurulum köprüyü hazırlar. Doğrudan HTTPS adresi girmezsen SSH tüneli kullanılır.</p><div className="form-grid"><label>Köprü portu<input type="number" value={bridgePort} onChange={e => setBridgePort(e.target.value)} min={1} max={65535} placeholder="Otomatik boş port"/></label><label>Doğrudan köprü adresi<input type="url" value={bridgeUrl} onChange={e => setBridgeUrl(e.target.value)} placeholder="İsteğe bağlı HTTPS adresi"/></label></div><label>Mevcut köprü anahtarı<input type="password" value={bridgeToken} onChange={e => setBridgeToken(e.target.value)} placeholder="İsteğe bağlı; yeni kurulumda oluşturulur" autoComplete="new-password"/></label></div>
    <div className="permission-note"><ShieldCheck size={20}/><p>{installMode === 'auto' ? 'Son düğmeye bastığında yeni oyun sunucusunun otomatik kurulumu hemen başlar.' : 'Sonraki adımda manuel kurulum komutları gösterilir.'}</p></div>
   </>}
   {stage === 'install' && <>
    <div className="install-summary"><span className="welcome-icon"><Terminal size={29}/></span><div><h3>{name}</h3><p>{games[game]} · {edition} · {version}</p><span className="tag">{install?.status || 'Plan hazırlanıyor'}</span></div></div>
    <div className="install-plan"><h4>Kurulum komutları</h4><pre>{install?.plan?.steps?.map((item: any) => `# ${item.label}\n${item.command}`).join('\n\n') || install?.plan?.script || JSON.stringify(install?.plan || {}, null, 2)}</pre></div>
    {!!install?.plan?.notes?.length && <div className="discovery-warnings"><h4>Kurulum notları</h4><ul>{install.plan.notes.map((note: string, i: number) => <li key={i}>{note}</li>)}</ul></div>}
    {install?.logs?.length > 0 && <div className="install-plan"><h4>Kurulum günlüğü</h4><pre>{install.logs.map((line: any) => typeof line === 'string' ? line : line.message).join('\n')}</pre></div>}
    <div className="modal-actions">{installMode === 'auto' && install?.status === 'error' && <button className="button primary" type="button" disabled={busy} onClick={retryInstall}><RefreshCw size={17}/> Kurulumu yeniden dene</button>}<button className="button secondary" type="button" onClick={() => onCreated(result.id)}>Panele dön <ArrowRight size={17}/></button></div>
   </>}
   {stage !== 'install' && <div className="modal-actions">{stage !== 'choice' ? <button type="button" className="button secondary" disabled={busy} onClick={() => move(stage === 'review' ? 'connection' : stage === 'connection' ? installed ? 'choice' : 'software' : stage === 'setup' ? 'connection' : 'choice')}>Geri</button> : <span className="field-help">{installed ? 'Mevcut sunucu için doğrudan bağlantı' : 'Yeni sunucu kurulumu'}</span>}<button className="button primary" disabled={busy || stage === 'review' && !candidate}>{busy ? <><LoaderCircle size={18} className="spin"/>{stage === 'connection' ? 'Sunucu taranıyor…' : 'İşlem yapılıyor…'}</> : stage === 'review' ? <>Bu sunucuyu bağla <ArrowRight size={17}/></> : stage === 'connection' && installed ? <><Search size={17}/> Mevcut sunucuyu tara</> : stage === 'setup' ? <>{installMode === 'auto' ? 'Otomatik kurulumu başlat' : 'Manuel planı göster'} <ArrowRight size={17}/></> : <>Devam et <ArrowRight size={17}/></>}</button></div>}
  </form>
 </Modal>;
}
