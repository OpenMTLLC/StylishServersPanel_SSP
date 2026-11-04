# SSP oyun köprüsü

İki küçük bileşen gerçek sunucuyla iletişimi sağlar:

- `bridge/ssp_bridge.py`: Python 3.10+; yalnız standart kütüphane. Oyun sürecini
  başlatır/durdurur, stdin'e komut gönderir, stdout günlüklerini toplar ve
  Modrinth dosyalarını uyumluluk/özet denetimiyle yönetir.
- `bridge/paper`: Paper 1.21.4 API'sine karşı derlenen Java 21 eklentisi.
  Gerçek oyuncu adı/UUID/ping/toplam oyun süresi/çevrimiçi durumu, ban ve OP
  yönetimi, sohbet/komut/fısıltı gözlemi, ana envanter ve ender sandığı erişimi.

```text
Tarayıcı → SSP API → parmak izi doğrulanmış SSH tüneli
                         ↓
               127.0.0.1:<köprü-portu> Python süreç köprüsü
                         ↓
               127.0.0.1:<sağlayıcı-portu> Paper eklentisi
```

Her iki HTTP servisinde de `Authorization: Bearer <anahtar>` gerekir. Anahtar
en az 32 URL-güvenli karakterdir; iki servis localhost'a bağlanır. Python
sağlayıcı isteklerinde yönlendirme izlenmez. HTTPS köprü adresi kullanılırsa
standart TLS sertifika doğrulaması korunur.

## Kurulum

Otomatik sunucu kurulumunda süreç köprüsü de kurulup başlatılır. Paper JAR
otomatik yüklemesi için paneli çalıştırmadan önce yerel repoda:

```sh
mvn -B -f bridge/paper/pom.xml package
```

Çıktı `bridge/paper/target/ssp-paper-bridge-0.1.0.jar` dosyasıdır. Derleme Java
21+ ve Maven 3.9+ ister. Daha yeni Minecraft/Paper sürümlerine dağıtmadan önce
hedef API ve canlı eklenti uyumluluğunu ayrıca doğrulayın. Bu sürüm Paper
1.21.4 API'siyle derleme doğrulamasına sahiptir; tüm sürümlerde oyun testi
yapıldığı iddia edilmez.

Hazır kurulu oyun için bu dosyayı `plugins/` altına, `ssp_bridge.py` dosyasını
sunucu dizinine kopyalayın. Örnek `.ssp-env` (gerçek anahtarı repoya eklemeyin):

```sh
SSP_BRIDGE_TOKEN='BURAYA_EN_AZ_32_KARAKTER_RASTGELE_ANAHTAR'
SSP_PROVIDER_TOKEN='BURAYA_AYNI_ANAHTAR'
SSP_SERVER_DIR='/home/ssp/minecraft'
SSP_GAME_VERSION='1.21.4'
SSP_LOADER='paper'
SSP_BRIDGE_PORT='8765'
SSP_PROVIDER_URL='http://127.0.0.1:8787'
SSP_START_COMMAND='./start.sh'
```

```sh
chmod 600 .ssp-env
set -a
. ./.ssp-env
set +a
python3 -u ssp_bridge.py
```

`start.sh` Java'yı `exec java -Xms512M -Xmx2048M -jar server.jar nogui` gibi
başlatmalı ve standart girdi/çıktıyı açık bırakmalıdır. Ayrı screen/tmux/arka
plan işlemi başlatmayın. `SSP_START_COMMAND` shell üzerinden çalıştırılmaz;
program ve argümanlar olarak ayrıştırılır. Oyun yalnız panelin **Başlat** isteğiyle
açılır. Durdurma, `stop` komutu ve en çok 30 saniye bekleme kullanır; dünya
güvenliği için süre aşımında zorla öldürme yapılmaz.

Paper `plugins/SSPBridge/config.yml`:

```yaml
port: 8787
token: 'SSP_PROVIDER_TOKEN_ILE_AYNI_DEGER'
moderator-command: ''
player-command: ''
```

Token boşsa eklenti yeni tokenı dosyada üretir, günlüğe yazmaz. Python sağlayıcı
anahtarıyla aynı değeri ayarlayın; dosyayı yalnız oyun kullanıcısı okuyabilsin.
Panelde SSH kimlik bilgilerini, doğrulanmış parmak izini ve süreç köprüsü
anahtarını girin. Köprü portu otomatik kurulumda her sunucu için atanır; manuel
kurulumda varsayılan `8765` kullanılır. Bir makinedeki her sunucunun süreç ve
oyuncu köprüsü portları farklı olmalıdır.

## Kalıcı servis

Otomatik bootstrap `nohup` kullanır; makine yeniden başlatılınca başlatılmaz.
Yönetici olarak kalıcı servis isterseniz köprüyü ayrı kullanıcıyla systemd altında
çalıştırın. Aşağıdaki yolları/kullanıcıyı gerçek değerlerle değiştirin:

```ini
[Unit]
Description=SSP Minecraft bridge
After=network.target

[Service]
Type=simple
User=ssp
WorkingDirectory=/home/ssp/minecraft
EnvironmentFile=/home/ssp/minecraft/.ssp-env
ExecStart=/usr/bin/python3 -u /home/ssp/minecraft/ssp_bridge.py
Restart=on-failure
UMask=0077
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

Önce mevcut nohup köprüsünü durdurun; aynı porta ikinci köprü açmayın. systemd
servis durdurmada süreç ağacını yönetir; sunucuyu önce panelden düzgünce durdurun.

## Yetki ve envanter davranışı

Varsayılan `admin` Minecraft OP verir; `player` OP'yi alır. `moderator` rolü
genel bir Minecraft yetkisi olmadığı için bir permissions eklentisinin gerçek
komutu yapılandırılmadıkça reddedilir. Örneğin LuckPerms için:

```yaml
moderator-command: 'lp user {uuid} parent set moderator'
player-command: 'lp user {uuid} parent set default'
admin-command: 'lp user {uuid} parent set admin'
```

Özel rol komutu yapılandırıldığında o rol ayrıca OP vermez; önceki OP kaldırılır.
Özel gruptan başka role geçişte hedef rolün komutu eksikse işlem reddedilir;
arayüzde yetki alınmış gibi gösterilmez. Eklenti komutunun doğru grupları
uygulaması sunucu yöneticisinin permissions yapılandırmasına bağlıdır.

Envanter erişimi çevrimiçi oyuncular içindir. Çevrimdışı dünya/NBT dosyalarına
yazılmaz. Ana envanter ve ender sandığı desteklenir. Özel eşya verileri
`ItemStack.serializeAsBytes()` ile taşınır; UI aynı eşyayı düzenlerken `data`
alanını korumalıdır. Tür değişiminde eski özel veri kaldırılmalıdır. Sunucu
yuva numarası, yinelenen yuva, eşya türü ve yığın miktarını doğrular.

### Çanta/mod sağlayıcısı eklemek

Her modun farklı depolama biçimi vardır. SSP bunu tahmin ederek dosyayı bozmaz.
Paper çanta eklentisi kendi gerçek Bukkit envanterini `BukkitContainerProvider`
ile kaydedebilir. Bağımlı eklentide `softdepend: [SSPBridge]` kullanın:

```java
SSPBridgePlugin ssp = (SSPBridgePlugin) Bukkit.getPluginManager().getPlugin("SSPBridge");
ssp.registerInventoryProvider(new BukkitContainerProvider(
    "backpack", "Çanta", player -> yourBackpackPlugin.getInventory(player.getUniqueId())
));
```

`yourBackpackPlugin.getInventory` ilgili eklentinin gerçek API çağrısıyla
değiştirilir; bu isim hazır bir üçüncü taraf entegrasyonu iddiası değildir.
Doğrudan `InventoryProvider` uygulayarak modun kaydetme/kilitleme kurallarını
koruyabilirsiniz. Çağrılar Minecraft ana iş parçacığındadır. Sağlayıcı
kaydedilmediyse çanta görüntülenmez ve erişim isteği açık hata döndürür.

Fabric/Forge çanta desteği için o yükleyiciye ait bir companion mod, aynı HTTP
sağlayıcı sözleşmesini uygulamalıdır. Bu repoda hazır Fabric/Forge companion
modu yoktur. O sunucularda süreç/konsol ve Modrinth yönetimi kullanılabilir;
oyuncu/çanta verileri sağlayıcı gelene kadar kullanılamaz.

## Sohbetin sınırları

Paper genel sohbeti ve `/msg`, `/tell`, `/w`, `/whisper` girişlerini gözlemler.
Başka eklentilerin özel mesaj sistemleri kendi olaylarını/sağlayıcısını
bağlamalıdır. Komut gözlemi bir komutun oyun tarafından başarıyla yürütüldüğünün
kanıtı değildir. Bilinen kimlik doğrulama komutları için parametreler gizlenir;
sunucu eklentilerinin konsola kendilerinin yazdığı hassas çıktılar ayrıca
yönetilmelidir. Sohbet 1000, süreç konsolu 500 kayıtla bellekte tutulur;
panel işlem geçmişinin kalıcı 90 günlük saklama politikası ayrı uygulanır.

## Modrinth yükleme

Oyun durdurulmuş olmalıdır. Köprü kendi sürecini, oyun sağlayıcısının canlılığını
ve Linux dünya `session.lock` kilitlerini denetler. Paper için Paper/Spigot/Bukkit
uyumlu eklentiler `plugins/` dizinine; Fabric/Forge/NeoForge için uyumlu modlar
`mods/` dizinine yüklenir. Tam oyun sürümü, loader ve kararlı yayın koşulları
yeniden sunucuda doğrulanır. Gerekli bağımlılık eksikse önce o bağımlılığın
yüklenmesi istenir. Dosya yalnız resmî Modrinth CDN'sinden alınır; SHA512
uyuşmazsa kurulmaz. Mevcut dosyaların üzerine yazılmaz. Kaldırma yalnız SSP'nin
kendi kayıt dosyasındaki modlarda yapılır; JAR `.ssp-removed/` karantinasına
taşınır. Yeni sürüm için önce eski sürümü kaldırın.

## Sağlayıcı HTTP sözleşmesi

| Yol | İşlev |
| --- | --- |
| `GET /state` | `{status,players,chat,mods,console,metrics,inventoryProviders}` |
| `POST /power` | `{action:"start"\|"stop"\|"restart"}` süreç köprüsünde |
| `POST /command` | `{command}` tek satırlık oyun komutu |
| `POST /chat` | `{message}` SSP etiketiyle yayın |
| `PATCH /players/:uuid` | `{banned?,role?}` |
| `GET /players/:uuid/inventory?provider=main` | `{provider,slots,capacity,writable}` |
| `PUT /players/:uuid/inventory?provider=main` | `{slots:[{slot,item,count,data?}]}` |
| `POST /mods` | `{projectId,versionId?}` |
| `DELETE /mods/:projectId` | Yönetilen JAR'ı karantinaya taşı |

Ölçülemeyen metrikler `null` döner; sahte CPU/ağ sayıları üretilmez. Paper
JVM belleği ve disk GiB, süre saniye cinsindendir. Oyuncu istatistikleri
sunucunun tuttuğu PLAY_ONE_MINUTE tick sayısından saniyeye çevrilir.

## Kaynaklar ve doğrulama

- [Paper plugin başlangıç ve derleme yapısı](https://docs.papermc.io/paper/dev/project-setup/)
- [Paper sohbet olayları ve ana iş parçacığı gereksinimi](https://docs.papermc.io/paper/dev/chat-events/)
- [Paper 1.21.4 API JavaDoc](https://jd.papermc.io/paper/1.21.4/)
- [Modrinth API](https://docs.modrinth.com/api/)
- [Modrinth proje sürümleri](https://docs.modrinth.com/api/operations/getprojectversions/)

`npm test` SSH parmak izi, EULA/indirme doğrulaması ve gerçek yerel SSH tünelini
denetler. `python -m unittest discover -s tests -p bridge_test.py -v` köprü
kimlik doğrulama/dosya güvenliği davranışlarını sınar. Maven derlemesi Paper API
uyumluluğunu denetler. Canlı uzak dünya ve üçüncü taraf modlarla uçtan uca oyun
testi, gerçek sunucu/eklenti kurulumu gerektirir.
