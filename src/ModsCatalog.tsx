import { t, locale } from './i18n';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Box, Boxes, Check, Download, ExternalLink, KeyRound, LoaderCircle, Package, Plus, Search, Settings2, ShieldCheck, Sparkles, Trash2 } from './icons';
type ProviderId = 'modrinth' | 'curseforge';
type CatalogProvider = {
    id: ProviderId;
    name: string;
    available: boolean;
    keyRequired: boolean;
    keyConfigured: boolean;
    reason?: string;
};
type CatalogMod = {
    id: string;
    projectId?: string;
    provider?: string;
    name: string;
    author?: string;
    description?: string;
    downloads?: number;
    version?: string;
    versionId?: string;
    compatible?: boolean;
    installable?: boolean;
    reason?: string;
    url?: string;
    serverSideVerified?: boolean;
    managed?: boolean;
};
type Props = {
    data: {
        server: {
            id: string;
            edition: string;
            version: string;
            curseforgeConfigured?: boolean;
        };
        mods: CatalogMod[];
    };
    api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
    action: (...args: any[]) => Promise<any>;
    canManage: boolean;
    canInstall?: boolean;
    canRemove?: boolean;
    busy: boolean;
    onSettings: () => void;
};
export default function ModsCatalog({ data, api, action, canManage, canInstall = canManage, canRemove = canManage, busy, onSettings }: Props) {
    const [view, setView] = useState<'installed' | 'discover'>('installed'), [provider, setProvider] = useState<ProviderId>('modrinth'), [providers, setProviders] = useState<CatalogProvider[]>([]);
    const [query, setQuery] = useState(''), [catalogue, setCatalogue] = useState<CatalogMod[]>([]), [searching, setSearching] = useState(false), [loadingProviders, setLoadingProviders] = useState(true), [error, setError] = useState('');
    const request = useRef(0);
    const currentProvider = providers.find(item => item.id === provider);
    useEffect(() => {
        let active = true;
        setLoadingProviders(true);
        setProviders([]);
        setError('');
        api<CatalogProvider[]>(`/api/mods/providers?serverId=${encodeURIComponent(data.server.id)}`).then(result => {
            if (active)
                setProviders(result);
        }).catch(e => {
            if (active)
                setError(e.message);
        }).finally(() => {
            if (active)
                setLoadingProviders(false);
        });
        return () => { active = false; };
    }, [api, data.server.id, data.server.curseforgeConfigured]);
    async function search(event?: FormEvent) {
        event?.preventDefault();
        if (view !== 'discover' || !currentProvider?.available)
            return;
        const id = ++request.current;
        setSearching(true);
        setError('');
        setCatalogue([]);
        try {
            const result = await api<CatalogMod[]>(`/api/mods/search?provider=${provider}&serverId=${encodeURIComponent(data.server.id)}&query=${encodeURIComponent(query.trim())}`);
            if (id === request.current)
                setCatalogue(result);
        }
        catch (e) {
            if (id === request.current)
                setError((e as Error).message);
        }
        finally {
            if (id === request.current)
                setSearching(false);
        }
    }
    useEffect(() => {
        request.current++;
        setCatalogue([]);
        setSearching(false);
        if (view === 'discover' && currentProvider?.available)
            void search();
        return () => { request.current++; };
    }, [view, provider, data.server.id, currentProvider?.available]);
    const installed = data.mods.filter(mod => `${mod.name} ${mod.description || ''}`.toLocaleLowerCase(locale()).includes(query.toLocaleLowerCase(locale())));
    const visible = view === 'installed' ? installed : catalogue;
    const installedProject = (mod: CatalogMod) => data.mods.some(item => item.id === mod.id || (item.provider === mod.provider && item.projectId === mod.projectId));
    return <>
  <div className="catalog-context"><Boxes size={22}/><strong>{t("Mod katalogları")}</strong><span>Modrinth / CurseForge</span><code>{data.server.edition === "neoforge" ? "NeoForge" : data.server.edition} · {data.server.version}</code></div>
  <section className="panel">
   <div className="table-toolbar"><div className="filter-tabs"><button className={view === 'installed' ? 'active' : ''} onClick={() => setView('installed')}><Package size={16}/>{" " + t("Yüklü modlar") + " "}<span className="count-pill">{data.mods.length}</span></button><button className={view === 'discover' ? 'active' : ''} onClick={() => setView('discover')}><Sparkles size={16}/>{" " + t("Mod keşfet")}</button></div><form className="mod-search" onSubmit={search}><div className="search-input"><Search size={17}/><input aria-label={t("Mod ara")} placeholder={t("Mod adıyla ara…")} value={query} onChange={e => setQuery(e.target.value)}/></div>{view === 'discover' && <button className="button secondary small" disabled={searching || !currentProvider?.available}>{t("Ara")}</button>}</form></div>
   {view === 'discover' && <div className="provider-toolbar"><div className="filter-tabs" aria-label={t("Mod kataloğu")}><button className={provider === 'modrinth' ? 'active' : ''} onClick={() => setProvider('modrinth')}>{t("Modrinth")}</button><button className={provider === 'curseforge' ? 'active' : ''} onClick={() => setProvider('curseforge')}>{t("CurseForge")}</button></div><p className="provider-note">{t("Uyumluluk seçili sunucunun oyun sürümü ve yükleyicisine göre kontrol edilir. Kurulumdan sonra sunucuyu yeniden başlat.")}</p></div>}
   {error && <div className="notice error" role="alert">{error}</div>}
   {view === 'discover' && loadingProviders ? <div className="loading"><LoaderCircle className="spin" size={23}/>{t("Kataloglar kontrol ediliyor…")}</div> : view === 'discover' && !currentProvider?.available ? <div className="provider-unavailable"><KeyRound size={25}/><div><h3>{provider === 'curseforge' ? t("CurseForge bağlantısını yapılandır") : t("Katalog kullanılamıyor")}</h3><p>{currentProvider?.reason || t("Bu sunucu için katalog bilgisi alınamadı.")}</p>{provider === 'curseforge' && currentProvider?.keyRequired && !currentProvider.keyConfigured && <button className="button secondary" onClick={onSettings}><Settings2 size={17}/>{" " + t("Ayarlarda CurseForge anahtarı ekle")}</button>}</div></div> : searching ? <div className="loading"><LoaderCircle className="spin" size={23}/>{t("Uyumlu modlar aranıyor…")}</div> : <>
    <div className="mods-scroll-region" tabIndex={0} role="region" aria-label={t("Mod listesi")}><div className="mods-grid">{visible.map((mod, i) => {
                const present = view === 'discover' && installedProject(mod);
                const installable = mod.compatible === true && mod.installable === true;
                return <article className="mod-card" key={mod.id}>
     <div className="mod-card-top"><span className={`mod-icon mod-color-${i % 4}`}><Box size={28}/></span>{view === 'installed' || present ? <span className="mod-installed"><span className="status-dot"/>{" " + t("Yüklü")}</span> : <span className="tag">{installable ? t("Sürüm ve yükleyici uyumlu") : t("Yüklenemiyor")}</span>}</div>
     <h3>{mod.name}</h3><span className="mod-author">{mod.author || 'Topluluk'}{mod.version && ` · ${mod.version}`}</span><p>{mod.description || t("Bu mod için açıklama bulunmuyor.")}</p>
     {mod.provider && <span className="provider-pill">{mod.provider === 'curseforge' ? t("CurseForge") : mod.provider === 'modrinth' ? t("Modrinth") : mod.provider}</span>}
     {view === 'discover' && mod.serverSideVerified === false && <p className="mod-install-reason">{t("Oyun sürümü ve yükleyici eşleşiyor; sunucu tarafında çalışma bilgisi sağlayıcı tarafından doğrulanmadı. Modun açıklamasını kontrol et.")}</p>}
     {mod.reason && <p className="mod-install-reason">{mod.reason}</p>}
     {mod.url && <a className="official-mod-link" href={mod.url} target="_blank" rel="noreferrer">{t("Proje sayfası") + " "}<ExternalLink size={14}/></a>}
     <div className="mod-card-footer">{view === 'installed' ? <><span><Package size={14}/>{mod.version || t("Sürüm bilinmiyor")}</span><button className="button small secondary" title={mod.managed === false ? t("SSH taramasında bulunan bu dosya panel tarafından yönetilmiyor.") : t("Modu kaldır")} disabled={!canRemove || busy || mod.managed === false} onClick={() => action(`/api/servers/${data.server.id}/mods/${encodeURIComponent(mod.id)}`, 'DELETE', undefined, t("Mod kaldırıldı."))}><Trash2 size={15}/>{" " + t("Kaldır")}</button></> : <><span><Download size={14}/>{Number(mod.downloads || 0).toLocaleString(locale())}</span><button className="button small primary" title={mod.reason} disabled={!canInstall || busy || !installable || present} onClick={() => action(`/api/servers/${data.server.id}/mods`, 'POST', { provider: mod.provider || provider, projectId: mod.projectId, ...(mod.versionId ? { versionId: mod.versionId } : {}), name: mod.name }, t("Mod ve zorunlu bağımlılıkları yüklendi. Sunucunu yeniden başlat."))}><Plus size={16}/>{present ? t("Yüklü") : t("Bağımlılıklarıyla yükle")}</button></>}</div>
    </article>;
            })}</div>
    </div>{!visible.length && <div className="empty-state"><Boxes size={30}/><strong>{view === 'installed' ? t("Henüz eşleşen mod yok") : t("Uyumlu mod bulunamadı")}</strong><p>{view === 'installed' ? t("Mod keşfet sekmesinden katalogları açabilirsin.") : t("Başka bir mod adıyla aramayı deneyebilirsin.")}</p></div>}
   </>}
  </section>
  <div className="overview-note"><ShieldCheck size={19}/><span>{t("Bağımlılıklar dahil kurulum")}</span><p>{t("Seçilen modun zorunlu bağımlılıkları aynı katalogdan çözülür. Oyun sürümü ve yükleyici eşleşmesi indirme öncesinde sunucu tarafında yeniden doğrulanır.")}</p></div>
 </>;
}
