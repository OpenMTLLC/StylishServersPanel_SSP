import { t, locale } from './i18n';
export type DiscoveredServer = {
    directory: string;
    game: string;
    edition: string;
    version: string | null;
    status: string;
    running: boolean | null;
    address?: string;
    port?: number;
    playersTotalSource?: 'world-history' | 'usercache-fallback';
    playersOnline: number | null;
    playersTotal: number | null;
    maxPlayers: number | null;
    mods?: {
        id: string;
        name: string;
        version?: string;
        filename?: string;
    }[];
    loadedMods?: number | null;
    metrics?: {
        memory?: number | null;
        memoryTotal?: number | null;
        machineMemoryTotal?: number | null;
        allocatedMemoryMb?: number | null;
        disk?: number | null;
        diskTotal?: number | null;
    };
    warnings?: string[];
};
export type Inspection = Partial<DiscoveredServer> & {
    candidates: DiscoveredServer[];
    machine?: {
        ramGb?: number | null;
        diskGb?: number | null;
        diskTotalGb?: number | null;
    };
    warnings?: string[];
    source?: string;
    observedAt?: string;
};
export const measured = (value: number | null | undefined, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString(locale(), { maximumFractionDigits: 2 })}${unit}` : '—';
export const discoveredStatus = (value?: string) => value === 'running' ? t("Çalışıyor") : value === 'stopped' ? t("Durdurulmuş") : t("Durum doğrulanamadı");
export default function DiscoverySummary({ server, scan, compact = false }: {
    server: DiscoveredServer;
    scan?: Partial<Inspection>;
    compact?: boolean;
}) {
    const metrics = server.metrics;
    const warnings = [...new Set([...(scan?.warnings || []), ...(server.warnings || [])])];
    const cards = [
        { label: t("Sunucu durumu"), value: discoveredStatus(server.status), detail: t("SSH taraması sırasında gözlenen durum") },
        { label: t("Çevrimiçi oyuncular"), value: measured(server.playersOnline), detail: t("Yalnızca doğrulanabilen çalışma zamanı bilgisi") },
        { label: server.playersTotalSource === 'usercache-fallback' ? t("Önbellekten tahmini oyuncu") : t("Toplam benzersiz oyuncu"), value: measured(server.playersTotal), detail: server.playersTotalSource === 'usercache-fallback' ? t("Önbellek kayıtlarından tahmin; dünya geçmişinin tamamını göstermeyebilir") : t("Sunucunun mevcut dünya oyuncu kayıtlarından") },
        { label: t("Diskte bulunan modlar"), value: server.mods ? measured(server.mods.length) : '—', detail: t("Çalışma zamanında yüklenmiş mod: {count}",{count:measured(server.loadedMods)}) },
        { label: t("Fiziksel sistem belleği"), value: measured(metrics?.machineMemoryTotal ?? scan?.machine?.ramGb, ' GB'), detail: t("Makinenin toplam RAM’i; oyun sunucusuna ayrılan bellek değildir") },
        { label: t("Sunucuya ayrılan bellek"), value: measured(metrics?.memoryTotal, ' GB'), detail: t("JVM -Xmx sınırı · Anlık sunucu kullanımı: {value}",{value:measured(metrics?.memory," GB")}) },
        { label: t("Disk kullanımı"), value: `${measured(metrics?.disk ?? scan?.machine?.diskGb)} / ${measured(metrics?.diskTotal ?? scan?.machine?.diskTotalGb)} GB`, detail: t("Sunucu dizininin bulunduğu dosya sistemi") },
        { label: t("Yazılım ve sürüm"), value: `${server.edition || 'Bilinmiyor'} · ${server.version || t("Sürüm doğrulanamadı")}`, detail: server.directory },
    ];
    return <>
  <div className="discovery-summary">{cards.map(card => <div key={card.label}><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></div>)}</div>
  {!compact && !!server.mods?.length && <div className="discovery-mod-list"><strong>{t("Bulunan mod dosyaları")}</strong><p>{server.mods.map(mod => `${mod.name}${mod.version ? ` (${mod.version})` : ''}`).join(' · ')}</p></div>}
  {warnings.length > 0 && <div className="discovery-warnings"><h4>{t("Tarama notları")}</h4><ul>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
 </>;
}
