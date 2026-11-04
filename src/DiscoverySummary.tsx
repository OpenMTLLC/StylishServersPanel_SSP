
export type DiscoveredServer = {
 directory: string; game: string; edition: string; version: string | null;
 status: string; running: boolean | null; address?: string; port?: number;
 playersTotalSource?: 'world-history' | 'usercache-fallback';
 playersOnline: number | null; playersTotal: number | null; maxPlayers: number | null;
 mods?: { id: string; name: string; version?: string; filename?: string }[];
 loadedMods?: number | null;
 metrics?: { memory?: number | null; memoryTotal?: number | null; machineMemoryTotal?: number | null; allocatedMemoryMb?: number | null; disk?: number | null; diskTotal?: number | null };
 warnings?: string[];
};
export type Inspection = Partial<DiscoveredServer> & {
 candidates: DiscoveredServer[]; machine?: { ramGb?: number | null; diskGb?: number | null; diskTotalGb?: number | null };
 warnings?: string[]; source?: string; observedAt?: string;
};
export const measured = (value: number | null | undefined, unit = '') => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('tr-TR', { maximumFractionDigits: 2 })}${unit}` : '—';
export const discoveredStatus = (value?: string) => value === 'running' ? 'Çalışıyor' : value === 'stopped' ? 'Durdurulmuş' : 'Durum doğrulanamadı';

export default function DiscoverySummary({ server, scan, compact = false }: { server: DiscoveredServer; scan?: Partial<Inspection>; compact?: boolean }) {
 const metrics = server.metrics;
 const warnings = [...new Set([...(scan?.warnings || []), ...(server.warnings || [])])];
 const cards = [
  { label: 'Sunucu durumu', value: discoveredStatus(server.status), detail: 'SSH taraması sırasında gözlenen durum' },
  { label: 'Çevrimiçi oyuncular', value: measured(server.playersOnline), detail: 'Yalnızca doğrulanabilen çalışma zamanı bilgisi' },
  { label: server.playersTotalSource === 'usercache-fallback' ? 'Önbellekten tahmini oyuncu' : 'Toplam benzersiz oyuncu', value: measured(server.playersTotal), detail: server.playersTotalSource === 'usercache-fallback' ? 'Önbellek kayıtlarından tahmin; dünya geçmişinin tamamını göstermeyebilir' : 'Sunucunun mevcut dünya oyuncu kayıtlarından' },
  { label: 'Diskte bulunan modlar', value: server.mods ? measured(server.mods.length) : '—', detail: `Çalışma zamanında yüklenmiş mod: ${measured(server.loadedMods)}` },
  { label: 'Fiziksel sistem belleği', value: measured(metrics?.machineMemoryTotal ?? scan?.machine?.ramGb, ' GB'), detail: 'Makinenin toplam RAM’i; oyun sunucusuna ayrılan bellek değildir' },
  { label: 'Sunucuya ayrılan bellek', value: measured(metrics?.memoryTotal, ' GB'), detail: `JVM -Xmx sınırı · Anlık sunucu kullanımı: ${measured(metrics?.memory, ' GB')}` },
  { label: 'Disk kullanımı', value: `${measured(metrics?.disk ?? scan?.machine?.diskGb)} / ${measured(metrics?.diskTotal ?? scan?.machine?.diskTotalGb)} GB`, detail: 'Sunucu dizininin bulunduğu dosya sistemi' },
  { label: 'Yazılım ve sürüm', value: `${server.edition || 'Bilinmiyor'} · ${server.version || 'Sürüm doğrulanamadı'}`, detail: server.directory },
 ];
 return <>
  <div className="discovery-summary">{cards.map(card => <div key={card.label}><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></div>)}</div>
  {!compact && !!server.mods?.length && <div className="discovery-mod-list"><strong>Bulunan mod dosyaları</strong><p>{server.mods.map(mod => `${mod.name}${mod.version ? ` (${mod.version})` : ''}`).join(' · ')}</p></div>}
  {warnings.length > 0 && <div className="discovery-warnings"><h4>Tarama notları</h4><ul>{warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
 </>;
}
