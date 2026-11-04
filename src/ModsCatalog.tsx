import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Boxes, Check, Download, ExternalLink, KeyRound, LoaderCircle, Package, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2 } from 'lucide-react';

type ProviderId = 'modrinth' | 'curseforge';
type CatalogProvider = { id: ProviderId; name: string; available: boolean; keyRequired: boolean; keyConfigured: boolean; reason?: string };
type CatalogMod = { id: string; projectId?: string; provider?: string; name: string; author?: string; description?: string; downloads?: number; version?: string; versionId?: string; compatible?: boolean; installable?: boolean; reason?: string; url?: string; serverSideVerified?: boolean; managed?: boolean };
type Props = { data: { server: { id: string; edition: string; version: string; curseforgeConfigured?: boolean }; mods: CatalogMod[] }; api: <T>(path: string, method?: string, body?: unknown) => Promise<T>; action: (...args: any[]) => Promise<any>; canManage: boolean; busy: boolean; onSettings: () => void };

export default function ModsCatalog({ data, api, action, canManage, busy, onSettings }: Props) {
 const [view, setView] = useState<'installed' | 'discover'>('installed'), [provider, setProvider] = useState<ProviderId>('modrinth'), [providers, setProviders] = useState<CatalogProvider[]>([]);
 const [query, setQuery] = useState(''), [catalogue, setCatalogue] = useState<CatalogMod[]>([]), [searching, setSearching] = useState(false), [loadingProviders, setLoadingProviders] = useState(true), [error, setError] = useState('');
 const request = useRef(0);
 const currentProvider = providers.find(item => item.id === provider);
 useEffect(() => {
  let active = true; setLoadingProviders(true); setProviders([]); setError('');
  api<CatalogProvider[]>(`/api/mods/providers?serverId=${encodeURIComponent(data.server.id)}`).then(result => { if (active) setProviders(result); }).catch(e => { if (active) setError(e.message); }).finally(() => { if (active) setLoadingProviders(false); });
  return () => { active = false; };
 }, [api, data.server.id, data.server.curseforgeConfigured]);
 async function search(event?: FormEvent) {
  event?.preventDefault(); if (view !== 'discover' || !currentProvider?.available) return;
  const id = ++request.current; setSearching(true); setError(''); setCatalogue([]);
  try { const result = await api<CatalogMod[]>(`/api/mods/search?provider=${provider}&serverId=${encodeURIComponent(data.server.id)}&query=${encodeURIComponent(query.trim())}`); if (id === request.current) setCatalogue(result); }
  catch (e) { if (id === request.current) setError((e as Error).message); }
  finally { if (id === request.current) setSearching(false); }
 }
 useEffect(() => { request.current++; setCatalogue([]); setSearching(false); if (view === 'discover' && currentProvider?.available) void search(); return () => { request.current++; }; }, [view, provider, data.server.id, currentProvider?.available]);
 const installed = data.mods.filter(mod => `${mod.name} ${mod.description || ''}`.toLocaleLowerCase('tr').includes(query.toLocaleLowerCase('tr')));
 const visible = view === 'installed' ? installed : catalogue;
 const installedProject = (mod: CatalogMod) => data.mods.some(item => item.id === mod.id || (item.provider === mod.provider && item.projectId === mod.projectId));
 return <>
  <div className="mods-hero"><div className="mods-hero-icon"><Boxes size={31}/></div><div><span className="eyebrow">DAHA FAZLA OLASILIK</span><h2>Bir sonraki maceranı ekle.</h2><p>Modrinth ve CurseForge kataloglarından sunucuna uygun modları ve zorunlu bağımlılıklarını tek tıkla yükle.</p></div><div className="compatibility-badge"><Check size={16}/>{data.server.edition === 'neoforge' ? 'NeoForge' : data.server.edition} · {data.server.version}</div></div>
  <section className="panel">
   <div className="table-toolbar"><div className="filter-tabs"><button className={view === 'installed' ? 'active' : ''} onClick={() => setView('installed')}><Package size={16}/> Yüklü modlar <span className="count-pill">{data.mods.length}</span></button><button className={view === 'discover' ? 'active' : ''} onClick={() => setView('discover')}><Sparkles size={16}/> Mod keşfet</button></div><form className="mod-search" onSubmit={search}><div className="search-input"><Search size={17}/><input aria-label="Mod ara" placeholder="Mod adıyla ara…" value={query} onChange={e => setQuery(e.target.value)}/></div>{view === 'discover' && <button className="button secondary small" disabled={searching || !currentProvider?.available}>Ara</button>}</form></div>
   {view === 'discover' && <div className="provider-toolbar"><div className="filter-tabs" aria-label="Mod kataloğu"><button className={provider === 'modrinth' ? 'active' : ''} onClick={() => setProvider('modrinth')}>Modrinth</button><button className={provider === 'curseforge' ? 'active' : ''} onClick={() => setProvider('curseforge')}>CurseForge</button></div><p className="provider-note">Uyumluluk seçili sunucunun oyun sürümü ve yükleyicisine göre kontrol edilir. Kurulumdan sonra sunucuyu yeniden başlat.</p></div>}
   {error && <div className="notice error" role="alert">{error}</div>}
   {view === 'discover' && loadingProviders ? <div className="loading"><LoaderCircle className="spin" size={23}/>Kataloglar kontrol ediliyor…</div> : view === 'discover' && !currentProvider?.available ? <div className="provider-unavailable"><KeyRound size={25}/><div><h3>{provider === 'curseforge' ? 'CurseForge bağlantısını yapılandır' : 'Katalog kullanılamıyor'}</h3><p>{currentProvider?.reason || 'Bu sunucu için katalog bilgisi alınamadı.'}</p>{provider === 'curseforge' && currentProvider?.keyRequired && !currentProvider.keyConfigured && <button className="button secondary" onClick={onSettings}><Settings2 size={17}/> Ayarlarda CurseForge anahtarı ekle</button>}</div></div> : searching ? <div className="loading"><LoaderCircle className="spin" size={23}/>Uyumlu modlar aranıyor…</div> : <>
    <div className="mods-grid">{visible.map((mod, i) => { const present = view === 'discover' && installedProject(mod); const installable = mod.compatible === true && mod.installable === true; return <article className="mod-card" key={mod.id}>
     <div className="mod-card-top"><span className={`mod-icon mod-color-${i % 4}`}><Box size={28}/></span>{view === 'installed' || present ? <span className="mod-installed"><span className="status-dot"/> Yüklü</span> : <span className="tag">{installable ? 'Sürüm ve yükleyici uyumlu' : 'Yüklenemiyor'}</span>}</div>
     <h3>{mod.name}</h3><span className="mod-author">{mod.author || 'Topluluk'}{mod.version && ` · ${mod.version}`}</span><p>{mod.description || 'Bu mod için açıklama bulunmuyor.'}</p>
     {mod.provider && <span className="provider-pill">{mod.provider === 'curseforge' ? 'CurseForge' : mod.provider === 'modrinth' ? 'Modrinth' : mod.provider}</span>}
     {view === 'discover' && mod.serverSideVerified === false && <p className="mod-install-reason">Oyun sürümü ve yükleyici eşleşiyor; sunucu tarafında çalışma bilgisi sağlayıcı tarafından doğrulanmadı. Modun açıklamasını kontrol et.</p>}
     {mod.reason && <p className="mod-install-reason">{mod.reason}</p>}
     {mod.url && <a className="official-mod-link" href={mod.url} target="_blank" rel="noreferrer">Proje sayfası <ExternalLink size={14}/></a>}
     <div className="mod-card-footer">{view === 'installed' ? <><span><Package size={14}/>{mod.version || 'Sürüm bilinmiyor'}</span><button className="button small secondary" title={mod.managed === false ? 'SSH taramasında bulunan bu dosya panel tarafından yönetilmiyor.' : 'Modu kaldır'} disabled={!canManage || busy || mod.managed === false} onClick={() => action(`/api/servers/${data.server.id}/mods/${encodeURIComponent(mod.id)}`, 'DELETE', undefined, 'Mod kaldırıldı.')}><Trash2 size={15}/> Kaldır</button></> : <><span><Download size={14}/>{Number(mod.downloads || 0).toLocaleString('tr-TR')}</span><button className="button small primary" title={mod.reason} disabled={!canManage || busy || !installable || present} onClick={() => action(`/api/servers/${data.server.id}/mods`, 'POST', { provider: mod.provider || provider, projectId: mod.projectId, ...(mod.versionId ? { versionId: mod.versionId } : {}), name: mod.name }, 'Mod ve zorunlu bağımlılıkları yüklendi. Sunucunu yeniden başlat.')}><Plus size={16}/>{present ? 'Yüklü' : 'Bağımlılıklarıyla yükle'}</button></>}</div>
    </article>; })}</div>
    {!visible.length && <div className="empty-state"><Boxes size={30}/><strong>{view === 'installed' ? 'Henüz eşleşen mod yok' : 'Uyumlu mod bulunamadı'}</strong><p>{view === 'installed' ? 'Mod keşfet sekmesinden katalogları açabilirsin.' : 'Başka bir mod adıyla aramayı deneyebilirsin.'}</p></div>}
   </>}
  </section>
  <div className="overview-note"><ShieldCheck size={19}/><span>Bağımlılıklar dahil kurulum</span><p>Seçilen modun zorunlu bağımlılıkları aynı katalogdan çözülür. Oyun sürümü ve yükleyici eşleşmesi indirme öncesinde sunucu tarafında yeniden doğrulanır.</p></div>
 </>;
}
