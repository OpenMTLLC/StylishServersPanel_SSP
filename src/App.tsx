import AuthScreen from './AuthScreen';
import PlayersPanel from './PlayersPanel';
import ActivityLedger from './ActivityLedger';
import SettingsPanel from './SettingsPanel';
import BinaryBackground, { PreferencesControls } from './Preferences';
import { usePreferences, t, locale } from './i18n';
import ServerWizard from './ServerWizard';
import ModsCatalog from './ModsCatalog';
import DiscoverySummary, { measured, type DiscoveredServer } from './DiscoverySummary';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, ArrowDown, ArrowDownLeft, ArrowRight, ArrowUpRight, Ban, Box, Boxes, Check, CheckCheck, ChevronDown, ChevronRight, CircleHelp, Clock3, Command, Copy, Cpu, Database, Download, Ellipsis, ExternalLink, Eye, FileClock, Fingerprint, Gamepad2, HardDrive, Hash, KeyRound, LayoutDashboard, Link2, LoaderCircle, LockKeyhole, LogOut, MemoryStick, Menu, MessageSquare, MoreHorizontal, Package, Play, Plus, Power, RefreshCw, Search, Send, Server, Settings2, Shield, ShieldCheck, SlidersHorizontal, Sparkles, Square, Terminal, Trash2, Undo2, Users, Wifi, X, Zap } from './icons';
type User = {
    id: string;
    username: string;
};
type Session = {
    user: User;
    csrfToken: string;
    serverId?: string;
};
type Game = 'minecraft' | 'valheim' | 'terraria' | 'rust';
type ServerInfo = {
    id: string;
    name: string;
    game: Game;
    edition: string;
    version: string;
    status: string;
    address: string;
    maxPlayers: number;
    permissions: string;
    access: {
        tabs: Tab[];
        actions: string[];
    };
    connection?: {
        type?: string;
        url?: string;
        host: string;
        port: number;
        username: string;
    };
    retentionDays: number;
    undoEnabled: boolean;
    bridgeConfigured?: boolean;
    bridgePort?: number;
    curseforgeConfigured?: boolean;
    directory?: string;
};
type Player = {
    uuid: string;
    name: string;
    ping: number;
    playTime: number;
    online: boolean;
    role: string;
    banned: boolean;
};
type ChatMessage = {
    id: string;
    player: string;
    recipient?: string;
    type: string;
    message: string;
    timestamp: string;
};
type Mod = {
    id: string;
    name: string;
    version: string;
    author: string;
    description: string;
    enabled: boolean;
    downloads?: number;
    slug?: string;
    projectId?: string;
    icon_url?: string;
    title?: string;
    project_id?: string;
    provider?: string;
    url?: string;
    installable?: boolean;
    compatible?: boolean;
    reason?: string;
    managed?: boolean;
};
type Audit = {
    id: string;
    actor: string;
    action: string;
    detail: string;
    timestamp: string;
    reversible: boolean;
    undone: boolean;
    canUndo: boolean;
};
type Slot = {
    slot: number;
    item: string;
    count: number;
    icon?: string;
    data?: string;
};
type Inventory = {
    provider: string;
    slots: Slot[];
    capacity: number;
    writable: boolean;
};
type Provider = {
    id: string;
    name: string;
    label?: string;
    capacity: number;
    writable: boolean;
    mod?: string;
};
type ConsoleLine = {
    timestamp: string;
    level: string;
    message: string;
};
type Metrics = {
    machineMemoryTotal?: number;
    allocatedMemoryMb?: number | null;
    cpu: number;
    memory: number;
    memoryTotal: number;
    disk: number;
    diskTotal: number;
    tps: number;
    uptime: number;
    networkIn: number;
    networkOut: number;
};
type ServerData = {
    server: ServerInfo;
    players: Player[];
    chat: ChatMessage[];
    mods: Mod[];
    activity: Audit[];
    metrics: Metrics | null;
    console: ConsoleLine[];
    inventoryProviders: Provider[];
    discovery?: DiscoveredServer & {
        observedAt?: string;
        source?: string;
    };
    playerCounts?: {
        online: number | null;
        total: number | null;
    };
    bridgeConnected?: boolean;
    source?: string;
    observedAt?: string;
};
type Tab = 'overview' | 'console' | 'players' | 'chat' | 'mods' | 'activity' | 'settings';
type Toast = {
    message: string;
    error?: boolean;
};
type Invite = {
    id: string;
    role: string;
    expires: string;
    revoked?: boolean;
    redeemed?: boolean;
};
const gameNames: Record<Game, string> = { minecraft: 'Minecraft', valheim: 'Valheim', terraria: 'Terraria', rust: 'Rust' };
const tabNames: Record<Tab, string> = { overview: 'Genel Bakış', console: 'Konsol', players: 'Oyuncular', chat: 'Sohbet', mods: 'Modlar', activity: 'İşlemler', settings: 'Ayarlar' };
const navItems = [{ id: 'overview', icon: LayoutDashboard }, { id: 'console', icon: Terminal }, { id: 'players', icon: Users }, { id: 'chat', icon: MessageSquare }, { id: 'mods', icon: Boxes }, { id: 'activity', icon: FileClock }, { id: 'settings', icon: Settings2 }] as const;
const time = (value: string) => new Date(value).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = (value: string) => new Date(value).toLocaleString(locale(), { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
const duration = (seconds: number) => t("{hours} sa {minutes} dk", { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds % 3600 / 60) });
const number = (value: number) => Number(value || 0).toLocaleString(locale(), { maximumFractionDigits: 1 });
const capitalize = (value: string) => value?.charAt(0).toUpperCase() + value?.slice(1);
function Mark({ small = false }: {
    small?: boolean;
}) { return <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true"><svg width="27" height="29" viewBox="0 0 27 29"><path d="M2 5L13.5 0 25 5v7l-11.5 5L2 12V5Zm0 12 11.5 5L25 17v7l-11.5 5L2 24v-7Z" fill="currentColor"/><path d="m13.5 7 6.5 3-6.5 3L7 10l6.5-3Z" fill="#111411"/></svg></span>; }
function Status({ online, label }: {
    online: boolean;
    label?: string;
}) { return <span className={`status ${label === t("Durum doğrulanamadı") ? 'unknown' : online ? 'online' : 'offline'}`}><span className="status-dot"/>{label ?? (online ? t("Çevrimiçi") : t("Çevrimdışı"))}</span>; }
function Avatar({ name, size = '' }: {
    name: string;
    size?: string;
}) { const colors = ['sage', 'sand', 'blue', 'rose', 'lilac']; const color = colors[(name?.charCodeAt(0) || 0) % 5]; return <span className={`avatar ${color} ${size}`} aria-hidden="true">{(name || '?').slice(0, 2).toUpperCase()}</span>; }
function Empty({ icon, title, description }: {
    icon?: ReactNode;
    title: string;
    description?: string;
}) { return <div className="empty-state">{icon || <Box size={28}/>}<strong>{title}</strong>{description && <p>{description}</p>}</div>; }
function Loading() { return <div className="loading"><LoaderCircle className="spin" size={23}/><span>{t("Panel hazırlanıyor…")}</span></div>; }
export function Modal({ title, subtitle, children, onClose, wide = false }: {
    title: string;
    subtitle?: string;
    children: ReactNode;
    onClose: () => void;
    wide?: boolean;
}) {
    const modalRef = useRef<HTMLDivElement>(null);
    const closeRef = useRef(onClose);
    closeRef.current = onClose;
    useEffect(() => {
        const previous = document.activeElement as HTMLElement;
        const handle = (event: KeyboardEvent) => {
            if (event.key === 'Escape')
                closeRef.current();
            if (event.key === 'Tab') {
                const elements = modalRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href]');
                if (!elements?.length)
                    return;
                const first = elements[0], last = elements[elements.length - 1];
                if (event.shiftKey && document.activeElement === first) {
                    event.preventDefault();
                    last.focus();
                }
                else if (!event.shiftKey && document.activeElement === last) {
                    event.preventDefault();
                    first.focus();
                }
            }
        };
        window.addEventListener('keydown', handle);
        modalRef.current?.querySelector<HTMLElement>('input,button')?.focus();
        const old = document.body.style.overflow;
        document.body.style.overflow = 'hidden';
        return () => { window.removeEventListener('keydown', handle); document.body.style.overflow = old; previous?.focus(); };
    }, []);
    return <div className="modal-overlay" onMouseDown={e => {
            if (e.target === e.currentTarget)
                onClose();
        }}><div className={`modal ${wide ? 'wide' : ''}`} ref={modalRef} role="dialog" aria-modal="true" aria-label={title}><div className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label={t("Kapat")} onClick={onClose}><X size={19}/></button></div>{children}</div></div>;
}
export default function App() {
    const preferences = usePreferences();
    const [session, setSession] = useState<Session | null>(null), [checking, setChecking] = useState(true), [needsSetup, setNeedsSetup] = useState(false);
    const [servers, setServers] = useState<ServerInfo[]>([]), [selected, setSelected] = useState(''), [data, setData] = useState<ServerData | null>(null), [tab, setTab] = useState<Tab>('overview');
    const selectedRef = useRef(selected); selectedRef.current = selected;
    const serversRef = useRef<ServerInfo[]>([]);
    serversRef.current = servers;
    const [toast, setToast] = useState<Toast | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [wizard, setWizard] = useState(false), [mobileNav, setMobileNav] = useState(false), [initialHost, setInitialHost] = useState('');
    const api = useCallback(async <T,>(path: string, method = 'GET', body?: unknown): Promise<T> => {
        const response = await fetch(path, { method, credentials: 'same-origin', headers: { 'Content-Type': 'application/json', ...(session?.csrfToken ? { 'x-csrf-token': session.csrfToken } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            if (response.status === 401 && !path.includes('/auth/')) {
                setSession(null);
                setData(null);
            }
            throw new Error(result.error || result.message || `İstek tamamlanamadı (${response.status}).`);
        }
        return result as T;
    }, [session?.csrfToken]);
    useEffect(() => {
        fetch('/api/session').then(async (r) => {
            const body = await r.json();
            if (r.ok)
                setSession(body);
            else
                setNeedsSetup(!!body.needsSetup);
        }).catch(() => setError(t("SSP API bağlantısı kurulamadı. Sunucu uygulamasının çalıştığını kontrol edin."))).finally(() => setChecking(false));
    }, []);
    const notify = (message: string, isError = false) => setToast({ message, error: isError });
    useEffect(() => {
        if (!toast)
            return;
        const timer = window.setTimeout(() => setToast(null), toast.error ? 8000 : 4000);
        return () => clearTimeout(timer);
    }, [toast]);
    const loadServers = useCallback(async () => { const list = await api<ServerInfo[]>('/api/servers'); setServers(list); setSelected(current => list.some(s => s.id === current) ? current : list[0]?.id || ''); return list; }, [api]);
    useEffect(() => {
        if (session)
            loadServers().catch(e => setError(e.message));
    }, [session?.user.id, loadServers]);
    const reload = useCallback(async () => {
        if (!selected)
            return;
        let next: ServerData;
        try {
            next = await api<ServerData>(`/api/servers/${selected}`);
        }
        catch (error) {
            if(selectedRef.current !== selected)return;
        const fallback = serversRef.current.find(s => s.id === selected);
            if (fallback)
                setData(current => current || { server: fallback, players: [], chat: [], mods: [], activity: [], metrics: null, console: [], inventoryProviders: [] });
            throw error;
        }
        setData(next);
        setError('');
        setServers(current => current.map(s => s.id === selected ? next.server : s));
    }, [api, selected]);
    useEffect(() => {
        setData(null);
        if (selected)
            reload().catch(e => setError(e.message));
    }, [selected, reload]);
    useEffect(() => {
        if (!selected || !session)
            return;
        const timer = window.setInterval(() => {
            if (document.visibilityState === 'visible')
                reload().catch(() => { });
        }, 10000);
        return () => clearInterval(timer);
    }, [reload, selected, session]);
    async function action(path: string, method = 'POST', body?: unknown, success = t("İşlem tamamlandı.")) {
        setBusy(true);
        try {
            const result = await api<any>(path, method, body);
            await reload();
            notify(success);
            return result;
        }
        catch (e) {
            notify((e as Error).message, true);
            return null;
        }
        finally {
            setBusy(false);
        }
    }
    async function signIn(value: Session) { setSession(value); setSelected(value.serverId || ''); setNeedsSetup(false); setError(''); }
    const server = data?.server, onlinePlayers = data?.playerCounts?.online ?? data?.discovery?.playersOnline ?? (data?.bridgeConnected || false ? data?.players.filter(p => p.online).length : null) ?? '—';
    const has = (action: string) => !!server?.access?.actions.includes(action);
    const canManage = has('server.power'), isAdmin = has('settings.write');
    const allowedTabs = server?.access?.tabs ?? servers.find(item => item.id === selected)?.access?.tabs ?? [];
    useEffect(() => {
        if (allowedTabs.length && !allowedTabs.includes(tab))
            setTab(allowedTabs[0] as Tab);
    }, [allowedTabs.join(','), tab]);
    async function copy(value: string) {
        try {
            await navigator.clipboard.writeText(value);
            notify(t("Panoya kopyalandı."));
        }
        catch {
            notify(t("Tarayıcı panoya erişemedi. Metni seçerek kopyalayabilirsiniz."), true);
        }
    }
    return <><BinaryBackground />{checking ? <div className="app-loading"><Mark /><Loading /></div> : !session ? <AuthScreen api={api} onSignIn={signIn} connectionError={error}/> : <div className="app-shell">
  <aside className={`sidebar ${mobileNav ? 'open' : ''}`}><a className="brand" href="#" onClick={e => { e.preventDefault(); setTab('overview'); }}><Mark /><div><strong>SSP<span className="brand-period">.</span></strong><span>STYLISH SERVERS PANEL</span></div></a><button className="icon-button mobile-close" aria-label={t("Menüyü kapat")} onClick={() => setMobileNav(false)}><X size={20}/></button>
   {null}<div className="workspace-card"><span className="workspace-icon"><Server size={19}/></span><div><strong>{t("Sunucularım")}</strong><span>{servers.length}{" " + t("sunucu bağlı")}</span></div><ChevronDown size={15}/></div>
   <div className="nav-label">{t("SUNUCU YÖNETİMİ")}</div><nav aria-label={t("Ana gezinme")}>{navItems.filter(item => allowedTabs.includes(item.id)).map(item => <button key={item.id} className={`nav-item ${tab === item.id ? 'active' : ''}`} onClick={() => { setTab(item.id); setMobileNav(false); }}><item.icon size={18}/><span>{t(tabNames[item.id])}</span>{item.id === 'players' && <span className="nav-count">{onlinePlayers}</span>}{item.id === 'chat' && <span className="nav-small-dot"/>}{tab === item.id && <span className="nav-active-line"/>}</button>)}</nav>
   <div className="sidebar-bottom"><a className="github-link" href="https://github.com/OpenMTLLC/StylishServersPanel_SSP" target="_blank" rel="noreferrer">GitHub <ExternalLink size={17}/></a><div className="account"><Avatar name={session.user.username}/><div><strong>{session.user.username}</strong><span>{t("Panel hesabı")}</span></div><button className="icon-button" title={t("Çıkış yap")} aria-label={t("Çıkış yap")} onClick={async () => {
                try {
                    await api('/api/auth/logout', 'POST');
                    setSession(null);
                    setServers([]);
                    setData(null);
                    setSelected('');
                }
                catch (e) {
                    notify((e as Error).message, true);
                }
            }}><LogOut size={17}/></button></div></div>
  </aside>{mobileNav && <div className="sidebar-backdrop" onClick={() => setMobileNav(false)}/>}
  <div className="main-shell"><header className="topbar"><div className="breadcrumbs"><button className="icon-button mobile-menu" aria-label={t("Menüyü aç")} onClick={() => setMobileNav(true)}><Menu size={20}/></button><Server size={15}/><span>{t("Sunucularım")}</span><ChevronRight size={14}/><strong>{server?.name || t("Çalışma alanı")}</strong></div><div className="topbar-right"><PreferencesControls />{null}<span className="topbar-divider"/><button className="icon-button" aria-label={t("Paneli yenile")} title={t("Yenile")} onClick={() => reload().then(() => notify(t("Veriler güncellendi."))).catch(e => notify(e.message, true))}><RefreshCw size={17}/></button><span className="version">{t("v0.3.0")}</span></div></header>
   <main><div className="page-title-row"><div><div className="eyebrow">{t("SUNUCUNUN KONTROL MERKEZİ")}</div><h1>{t(tabNames[tab])}<span className="title-dot">.</span></h1><p className="page-description">{tab === 'overview' ? t("Her şey yerli yerinde. Sunucun tek bir bakışta.") : tab === 'players' ? t("Topluluğunu tanı. Her oyuncuyu yakından takip et.") : tab === 'chat' ? t("Sunucundaki tüm konuşmalar, tek bir akışta.") : tab === 'mods' ? t("Sunucunun sınırlarını genişlet.") : tab === 'activity' ? t("Kim, ne zaman, ne yaptı? Tüm işlemler kayıt altında.") : tab === 'console' ? t("Sunucunun nabzını gerçek zamanlı takip et.") : t("Sunucunu, erişimleri ve panel tercihlerini yapılandır.")}</p></div><div className="page-actions"><div className="select-wrap server-select"><Gamepad2 size={16}/><select aria-label={t("Aktif sunucu")} value={selected} onChange={e => setSelected(e.target.value)}>{!servers.length && <option value="">{t("Sunucu seçin")}</option>}{servers.map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select><ChevronDown size={14}/></div><button className="button primary" onClick={() => setWizard(true)}><Plus size={16}/>{" " + t("Sunucu bağla")}</button></div></div>
    {error && <div className="notice error"><Shield size={17}/>{t(error)}<button className="text-button" onClick={() => reload().catch(e => setError(e.message))}>{t("Tekrar dene")}</button></div>}
    {false}
    {!servers.length ? <div className="welcome-panel"><Server size={38}/><h2>{t("Mevcut sunucuya bağlan")}</h2><p>{t("Sunucu bağlantısını doğrulayarak bu hesaba ekleyin.")}</p><button className="button primary" onClick={() => setWizard(true)}><Link2 size={18}/>{t("Sunucu bağla")}</button></div> : !data ? <Loading /> : <>
     <div className="server-overview-bar"><div className="server-identity"><div className={`game-icon ${server?.game}`}><Gamepad2 size={25}/></div><div><h2>{server?.name}<span className="tag">{gameNames[server?.game || 'minecraft']}</span></h2><button className="address-copy" title={t("Sunucu adresini kopyala")} onClick={() => copy(server?.address || '')}><span>{server?.address || t('Adres bekleniyor')}</span><Copy size={12}/></button></div></div><div className="server-bar-right"><Status online={server?.status === 'running'} label={server?.status === 'installing' ? 'Kuruluyor' : server?.status === 'error' ? t("Bağlantı hatası") : server?.status === 'running' ? t("Çevrimiçi") : server?.status === 'stopped' ? t("Çevrimdışı") : t("Durum doğrulanamadı")}/><span className="server-bar-divider"/><button className="button small secondary" disabled={!canManage || busy} onClick={() => action(`/api/servers/${selected}/power`, 'POST', { action: 'restart' }, t("Yeniden başlatma isteği gönderildi."))}><RefreshCw size={14}/>{" " + t("Yeniden başlat")}</button><button className={`button small ${server?.status === 'running' ? 'danger-outline' : 'primary'}`} disabled={!canManage || busy} onClick={() => action(`/api/servers/${selected}/power`, 'POST', { action: server?.status === 'running' ? 'stop' : 'start' }, server?.status === 'running' ? t("Durdurma isteği gönderildi.") : t("Başlatma isteği gönderildi."))}><Power size={14}/>{server?.status === 'running' ? t('Durdur') : t("Başlat")}</button></div></div>
     {tab === 'overview' && allowedTabs.includes('overview') && <Overview data={data} setTab={setTab} action={action} canManage={isAdmin} busy={busy}/>}
     {tab === 'console' && allowedTabs.includes('console') && <ConsolePanel lines={data.console || []} full onCommand={command => action(`/api/servers/${selected}/command`, 'POST', { command }, t("Komut sunucuya gönderildi."))} disabled={!has('console.execute') || busy}/>}
     {tab === 'players' && allowedTabs.includes('players') && <PlayersPanel key={data.server.id} data={data} api={api} action={action} notify={notify} canManage={canManage} isAdmin={isAdmin} busy={busy} copy={copy}/>}
     {tab === 'chat' && allowedTabs.includes('chat') && <Chat key={data.server.id} data={data} action={action} canManage={has('chat.send')} busy={busy}/>}
     {tab === 'mods' && allowedTabs.includes('mods') && <ModsCatalog key={data.server.id} data={data} api={api} action={action} canManage={has('mods.install') || has('mods.remove')} canInstall={has('mods.install')} canRemove={has('mods.remove')} busy={busy} onSettings={() => setTab('settings')}/>}
     {tab === 'activity' && allowedTabs.includes('activity') && <ActivityLedger key={data.server.id} data={data} action={action} canManage={canManage} isAdmin={isAdmin} busy={busy}/>}
     {tab === 'settings' && allowedTabs.includes('settings') && <SettingsPanel key={data.server.id} data={data} api={api} action={action} notify={notify} isAdmin={isAdmin} copy={copy} onServerAdded={() => loadServers()}/>}
    </>}

   </main>
  </div>
 </div>}
 {toast && <div className={`toast ${toast.error ? 'error' : ''}`} role={toast.error ? 'alert' : 'status'}>{toast.error ? <Shield size={18}/> : <CheckCheck size={18}/>}<span>{t(toast.message)}</span><button className="icon-button" aria-label={t("Bildirimi kapat")} onClick={() => setToast(null)}><X size={15}/></button></div>}
 {wizard && session && <ServerWizard api={api} initialHost={initialHost} onClose={() => setWizard(false)} onCreated={async (id) => { setWizard(false); await loadServers(); setSelected(id); setTab('overview'); notify(t("Sunucu çalışma alanına eklendi.")); }} notify={notify}/>}
 </>;
}
function Overview({ data, setTab, action, busy }: {
    data: ServerData;
    setTab: (tab: Tab) => void;
    action: (...args: any[]) => Promise<any>;
    canManage: boolean;
    busy: boolean;
}) {
    const metrics = data.metrics || {} as Metrics, online = (data.players || []).filter(player => player.online);
    const has = (name: string) => data.server.access.actions.includes(name), visible = (name: Tab) => data.server.access.tabs.includes(name);
    const onlineCount = data.playerCounts?.online ?? (data.bridgeConnected ? online.length : null), total = data.playerCounts?.total ?? (data.bridgeConnected ? data.players.length : null);
    const cards = [{ Icon: Users, label: t('Çevrimiçi oyuncular'), value: measured(onlineCount), unit: `/ ${measured(data.server.maxPlayers)}`, detail: t('{count} toplam oyuncu', { count: measured(total) }) }, { Icon: Cpu, label: t('İşlemci kullanımı'), value: measured(metrics.cpu), unit: '%', detail: t('CPU yükü') }, { Icon: MemoryStick, label: t('Sunucu belleği'), value: measured(metrics.memory), unit: `/ ${measured(metrics.memoryTotal)} GB`, detail: t('Sunucuya ayrılan bellek') }, { Icon: Activity, label: t('Sunucu performansı'), value: measured(metrics.tps), unit: data.server.game === 'minecraft' ? 'TPS' : t('tick/sn'), detail: t('Çalışma süresi') + ': ' + (typeof metrics.uptime === 'number' ? duration(metrics.uptime) : '—') }];
    return <>
 {data.discovery && <section className="panel discovery-panel"><div className="panel-heading"><div><Search size={19}/><h3>{t('Sunucu taraması')}</h3></div>{has('server.inspect') && <button className="button secondary small" disabled={busy} onClick={() => action(`/api/servers/${data.server.id}/inspect`, 'POST', undefined, t('Sunucu bilgileri güncellendi.'))}><RefreshCw size={16}/>{t('Yeniden tara')}</button>}</div><div className="discovery-panel-body"><DiscoverySummary server={data.discovery}/>{data.observedAt && <p className="field-help">{t('Son tarama')}: {date(data.observedAt)}</p>}</div></section>}
 <div className="stats-grid">{cards.map(({ Icon, label, value, unit, detail }) => <div className="stat-card" key={label}><div className="stat-top"><span><Icon size={19}/>{label}</span></div><div className="stat-value">{value}<span>{unit}</span></div><div className="stat-bottom"><span>{detail}</span></div></div>)}</div>
 <div className="dashboard-grid">
 {has('console.read') && <section className="panel dashboard-console"><div className="panel-heading"><div><Terminal size={20}/><h3>{t('Konsol')}</h3></div><button className="text-button" onClick={() => setTab('console')}>{t('Konsolu aç')}<ArrowUpRight size={16}/></button></div><ConsolePanel compact lines={data.console || []} onCommand={command => action(`/api/servers/${data.server.id}/command`, 'POST', { command }, t('Komut sunucuya gönderildi.'))} disabled={!has('console.execute') || busy}/></section>}
 <section className="panel server-details"><div className="panel-heading"><div><SlidersHorizontal size={20}/><h3>{t('Sunucu bilgileri')}</h3></div>{visible('settings') && <button className="icon-button" aria-label={t('Sunucu ayarlarını aç')} onClick={() => setTab('settings')}><ArrowUpRight size={18}/></button>}</div><div className="details-content"><div className="detail-item"><span>{t('Oyun türü')}</span><strong>{gameNames[data.server.game]}</strong></div><div className="detail-item"><span>{t('Sunucu yazılımı')}</span><strong>{data.server.edition === 'neoforge' ? 'NeoForge' : capitalize(data.server.edition)} <span className="mini-tag">{data.server.version}</span></strong></div><div className="detail-item"><span>{t('Çalışma süresi')}</span><strong>{typeof metrics.uptime === 'number' ? duration(metrics.uptime) : '—'}</strong></div>{has('mods.read') && <div className="detail-item"><span>{t('Yüklü modlar')}</span><button className="inline-link" onClick={() => setTab('mods')}>{data.mods.length}<ChevronRight size={16}/></button></div>}<div className="storage-usage"><div><span><HardDrive size={17}/>{t('Disk kullanımı')}</span><strong>{measured(metrics.disk)} / {measured(metrics.diskTotal)} GB</strong></div><div className="progress-track"><span style={{ width: `${Math.min(100, metrics.disk / metrics.diskTotal * 100) || 0}%` }}/></div></div></div></section>
 {has('players.read') && <section className="panel online-panel"><div className="panel-heading"><div><Users size={20}/><h3>{t('Çevrimiçi oyuncular')}</h3><span className="count-pill">{measured(onlineCount)}</span></div><button className="text-button" onClick={() => setTab('players')}>{t('Tüm oyuncular')}<ArrowUpRight size={16}/></button></div>{online.length ? <div className="compact-player-list">{online.slice(0, 4).map(player => <div className="compact-player" key={player.uuid}><div className="avatar-with-status"><Avatar name={player.name}/><span className="status-dot"/></div><div><strong>{player.name}</strong><span>{t(player.role === 'admin' ? t("Yönetici") : player.role === 'moderator' ? t("Moderatör") : t("Oyuncu"))}</span></div><span className="ping"><Wifi size={16}/>{player.ping}{" " + t("ms")}</span></div>)}</div> : <Empty title={data.bridgeConnected ? t('Şu an çevrimiçi oyuncu yok') : t('Oyuncu ayrıntıları için oyun köprüsünü bağlayın.')}/>}</section>}
 {has('activity.read') && <section className="panel recent-activity"><div className="panel-heading"><div><FileClock size={20}/><h3>{t('Son işlemler')}</h3></div><button className="text-button" onClick={() => setTab('activity')}>{t('Tüm geçmiş')}<ArrowUpRight size={16}/></button></div><div className="activity-preview">{data.activity.slice(0, 4).map(item => <div className="activity-preview-row" key={item.id}><span className="activity-event-icon"><FileClock size={18}/></span><div><strong>{item.detail}</strong><span>{item.actor}<i>·</i>{date(item.timestamp)}</span></div></div>)}{!data.activity.length && <Empty title={t('İşlemler burada görünecek')}/>}</div></section>}
 </div></>;
}
function ConsolePanel({ lines, full, compact, onCommand, disabled }: {
    lines: ConsoleLine[];
    full?: boolean;
    compact?: boolean;
    onCommand: (command: string) => Promise<any>;
    disabled?: boolean;
}) {
    const [command, setCommand] = useState(''), [filter, setFilter] = useState(''), [autoScroll, setAutoScroll] = useState(true);
    const logRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (autoScroll && logRef.current)
            logRef.current.scrollTop = logRef.current.scrollHeight;
    }, [lines, autoScroll]);
    async function submit(e: FormEvent) {
        e.preventDefault();
        if (!command.trim())
            return;
        const result = await onCommand(command.trim());
        if (result)
            setCommand('');
    }
    const visible = lines.filter(line => `${line.message} ${line.level}`.toLowerCase().includes(filter.toLowerCase()));
    return <div className={`console-panel ${full ? 'panel full-console' : ''} ${compact ? 'compact' : ''}`}>{full && <div className="panel-heading"><div><Terminal size={17}/><h3>{t("Sunucu konsolu")}</h3>{null}</div><label className="check-label"><input type="checkbox" checked={autoScroll} onChange={e => setAutoScroll(e.target.checked)}/>{" " + t("Otomatik kaydır")}</label></div>}{full && <div className="console-filter"><div className="search-input"><Search size={16}/><input placeholder={t("Konsolda ara…")} value={filter} onChange={e => setFilter(e.target.value)} aria-label={t("Konsolda ara")}/></div><span>{visible.length}{" " + t("satır")}</span></div>}<div className="console-lines" ref={logRef} role="log" aria-label={t("Sunucu konsolu")}>{visible.slice(compact ? -10 : -500).map((line, i) => <div className="console-line" key={`${line.timestamp}-${i}`}><span className="console-time">{time(line.timestamp)}</span><span className={`console-level ${(line.level || 'info').toLowerCase()}`}>{(line.level || 'INFO').toUpperCase()}</span><span className={/joined|başarı|ready|hazır|started|Done/i.test(line.message) ? 'success-message' : ''}>{line.message}</span></div>)}{!visible.length && <div className="console-idle">{t("Konsol çıktısı bekleniyor")}<span className="terminal-cursor"/></div>}</div><form className="console-command" onSubmit={submit}><ChevronRight size={17}/><input placeholder={disabled ? t("Konsol komutları için yönetici yetkisi gerekir") : 'Bir komut yaz…'} aria-label={t("Sunucu komutu")} value={command} onChange={e => setCommand(e.target.value)} maxLength={1000} disabled={disabled}/><kbd>↵</kbd><button aria-label={t("Komutu gönder")} type="submit" disabled={disabled || !command.trim()}><ArrowRight size={16}/></button></form></div>;
}
function Chat({ data, action, canManage, busy }: {
    data: ServerData;
    action: (...args: any[]) => Promise<any>;
    canManage: boolean;
    busy: boolean;
}) {
    const [filter, setFilter] = useState('all'), [query, setQuery] = useState(''), [player, setPlayer] = useState(''), [recipient, setRecipient] = useState(''), [message, setMessage] = useState('');
    const feed = useRef<HTMLDivElement>(null);
    const messages = data.chat.filter(m => (filter === 'all' || filter === 'player' || m.type === filter) && (!player || m.player === player || filter === 'whisper' && m.recipient === player) && (!recipient || m.player === recipient || m.recipient === recipient) && `${m.message} ${m.player}`.toLowerCase().includes(query.toLowerCase()));
    useEffect(() => {
        if (feed.current)
            feed.current.scrollTop = feed.current.scrollHeight;
    }, [data.chat.length, filter]);
    async function submit(event: FormEvent) {
        event.preventDefault();
        const result = await action(`/api/servers/${data.server.id}/chat`, 'POST', { message }, t("Mesaj sunucuya gönderildi."));
        if (result)
            setMessage('');
    }
    return <section className="panel chat-panel"><div className="chat-toolbar"><div className="filter-tabs">{[{ id: 'all', text: t("Tüm mesajlar") }, { id: 'global', text: t("Genel sohbet") }, { id: 'player', text: t("Oyuncu") }, { id: 'whisper', text: t("Fısıltılar") }, { id: 'command', text: 'Komutlar' }].map(f => <button className={filter === f.id ? 'active' : ''} key={f.id} onClick={() => { setFilter(f.id); setPlayer(''); setRecipient(''); }}>{f.id === 'command' ? <Terminal size={14}/> : f.id === 'whisper' ? <LockKeyhole size={14}/> : f.id === 'all' ? <MessageSquare size={14}/> : f.id === 'player' ? <Users size={14}/> : <Hash size={14}/>}{f.text}</button>)}</div>{null}</div><div className="chat-filters"><div className="search-input"><Search size={16}/><input placeholder={t("Mesajlarda ara…")} value={query} onChange={e => setQuery(e.target.value)} aria-label={t("Sohbet mesajlarını ara")}/></div>{(filter === 'player' || filter === 'whisper') && <select className="form-select" value={player} onChange={e => setPlayer(e.target.value)} aria-label={t("Oyuncuyu seç")}><option value="">{filter === 'whisper' ? t("Birinci oyuncu") : t("Tüm oyuncular")}</option>{data.players.map(p => <option key={p.uuid}>{p.name}</option>)}</select>}{filter === 'whisper' && <><ArrowRight size={15}/><select className="form-select" value={recipient} onChange={e => setRecipient(e.target.value)} aria-label={t("İkinci oyuncu")}><option value="">{t("İkinci oyuncu")}</option>{data.players.filter(p => p.name !== player).map(p => <option key={p.uuid}>{p.name}</option>)}</select></>}</div><div className="chat-feed" ref={feed} role="log" aria-label={t("Oyun içi sohbet")}><div className="chat-day-divider"><span />{messages.length}{" " + t("MESAJ")}<span /></div>{messages.map(m => <div className={`chat-message ${m.type === 'command' ? 'command-message' : ''}`} key={m.id}>{m.type === 'command' ? <span className="avatar command-avatar"><Terminal size={17}/></span> : <Avatar name={m.player}/>}<div className="chat-message-content"><div className="chat-meta"><strong>{m.player}</strong>{m.type === 'whisper' ? <span className="whisper-label"><LockKeyhole size={10}/>{m.recipient}{" " + t("kişisine fısıltı")}</span> : m.type === 'command' ? <span className="command-label">{t("KOMUT")}</span> : <span className="channel-label">{t("# genel")}</span>}<time>{time(m.timestamp)}</time></div><p>{m.message}</p></div></div>)}{!messages.length && <Empty icon={<MessageSquare size={28}/>} title={t("Bu filtrede mesaj yok")} description={t("Başka bir oyuncu veya sohbet türü seçebilirsin.")}/>}</div><form className="chat-compose" onSubmit={submit}><span className="compose-prefix"><ShieldCheck size={16}/>{" " + t("PANEL")}</span><input placeholder={canManage ? t("Oyun içi sohbete bir mesaj gönder…") : t("Bu hesabın sohbet gönderme yetkisi yok")} aria-label={t("Oyun içi mesaj")} value={message} onChange={e => setMessage(e.target.value)} required maxLength={500} disabled={!canManage || busy}/><button className="button primary small" disabled={!canManage || busy || !message.trim()}><Send size={14}/>{" " + t("Gönder")}</button></form><div className="chat-privacy"><LockKeyhole size={12}/>{" " + t("Fısıltılar yalnızca oyun köprüsü tarafından sağlandığında görünür. Erişimler panel yetkileriyle sınırlandırılır.")}</div></section>;
}
export function CurseForgeSettings({ server, api, notify, isAdmin }: {
    server: ServerInfo;
    api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
    notify: (message: string, error?: boolean) => void;
    isAdmin: boolean;
}) {
    const [key, setKey] = useState(''), [configured, setConfigured] = useState(!!server.curseforgeConfigured), [busy, setBusy] = useState(false);
    useEffect(() => { setKey(''); setConfigured(!!server.curseforgeConfigured); }, [server.id, server.curseforgeConfigured]);
    async function save(clear = false) {
        setBusy(true);
        try {
            await api(`/api/servers/${server.id}/connection`, 'PATCH', clear ? { clearCurseforgeApiKey: true } : { curseforgeApiKey: key.trim() });
            setConfigured(!clear);
            setKey('');
            notify(clear ? t("CurseForge API anahtarı kaldırıldı.") : t("CurseForge API anahtarı kaydedildi. Mod keşfet sekmesinden kataloğu açabilirsin."));
        }
        catch (e) {
            notify((e as Error).message, true);
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="bridge-form curseforge-settings"><div><KeyRound size={19}/><strong>{t("CurseForge kataloğu")}</strong><span className="tag">{configured ? t("ANAHTAR AYARLANMIŞ") : t("ANAHTAR GEREKLİ")}</span></div><p>{t("CurseForge mod araması ve yüklemesi için API anahtarını ekle. Anahtar sunucuda şifrelenerek saklanır ve yanıtlarda gösterilmez.")}</p><label>{t("CurseForge API anahtarı")}<input type="password" autoComplete="new-password" value={key} disabled={!isAdmin || busy} maxLength={512} placeholder={configured ? t("Değiştirmek için yeni anahtarı gir") : t("CurseForge API anahtarın")} onChange={e => setKey(e.target.value)}/></label><div className="button-row"><button type="button" className="button secondary" disabled={!isAdmin || busy || !key.trim()} onClick={() => save()}>{busy ? <LoaderCircle className="spin" size={16}/> : <Check size={16}/>}{" " + t("Anahtarı kaydet")}</button>{configured && <button type="button" className="button secondary" disabled={!isAdmin || busy} onClick={() => save(true)}><Trash2 size={16}/>{" " + t("Anahtarı kaldır")}</button>}</div></div>;
}
export function BridgeSettings({ server, api, notify, isAdmin }: {
    server: ServerInfo;
    api: <T>(path: string, method?: string, body?: unknown) => Promise<T>;
    notify: (message: string, error?: boolean) => void;
    isAdmin: boolean;
}) {
    const [token, setToken] = useState(''), [port, setPort] = useState(server.bridgePort || 8765), [url, setUrl] = useState(server.connection?.url || ''), [busy, setBusy] = useState(false);
    async function save() {
        setBusy(true);
        try {
            await api(`/api/servers/${server.id}/connection`, 'PATCH', { ...(server.connection?.type === 'bridge' ? (url.trim() ? {bridgeUrl:url.trim()} : {}) : {bridgePort:port,bridgeUrl:url}), ...(token ? { bridgeToken: token } : {}) });
            setToken('');
            notify(t("Oyun köprüsü bağlantısı kaydedildi. Veriler otomatik güncellenecek."));
        }
        catch (e) {
            notify((e as Error).message, true);
        }
        finally {
            setBusy(false);
        }
    }
    return <div className="bridge-form"><div><Link2 size={17}/><strong>{t("Oyun köprüsü")}</strong><span className="tag">{server.bridgeConfigured ? t("AYARLANMIŞ") : t("BAĞLANTI BEKLİYOR")}</span></div><p>{t("Adres boşken SSH tüneli kullanılır. Köprü anahtarını uzak sunucudaki SSP Bridge yapılandırmasından al.")}</p><div className="form-grid"><label>{t("Köprü portu")}<input type="number" min="1" max="65535" value={port} disabled={!isAdmin} onChange={e => setPort(Number(e.target.value))}/></label><label>{t("Doğrudan HTTPS adresi")}<input type="url" value={url} disabled={!isAdmin} placeholder={t("İsteğe bağlı")} onChange={e => setUrl(e.target.value)}/></label></div><label>{t("Köprü anahtarı")}<input type="password" autoComplete="new-password" minLength={32} maxLength={256} value={token} disabled={!isAdmin} placeholder={server.bridgeConfigured ? t("Değiştirmek için yeni anahtarı gir") : t("SSP Bridge token")} onChange={e => setToken(e.target.value)}/></label><button type="button" className="button secondary" disabled={!isAdmin || busy || (token.length > 0 && token.length < 32)} onClick={save}>{busy ? <LoaderCircle className="spin" size={14}/> : <Check size={14}/>}{" " + t("Köprü bağlantısını kaydet")}</button></div>;
}
