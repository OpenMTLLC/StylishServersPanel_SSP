# SSH bağlantısı ve otomatik kurulum

SSP, uzak Linux sunucusuna tarayıcıdan değil panel API'sinden bağlanır. SSH
kimlik bilgileri panel veri dizininde AES-GCM ile şifrelenir. Her bağlantıda
sunucunun SHA256 anahtar parmak izi doğrulanır. İlk **Bağlantıyı test et** isteği
yalnızca anahtarı öğrenir; bu aşamada parola/özel anahtar gönderilmez ve komut
çalıştırılmaz. Parmak izi onaylandıktan sonra yapılan test `uname -s` çalıştırır.

Uzak makinenin konsolundan bağımsız olarak doğrulayın:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Sunucu farklı algoritmayla anahtar sunuyorsa ilgili `ssh_host_*_key.pub` dosyasını
kontrol edin. Ekranda görülen değeri körü körüne kabul etmeyin. Anahtar değişirse
SSP bağlantıyı reddeder; yeni anahtarı ancak değişikliğin nedenini doğruladıktan
sonra kullanın. SSH tüneli, köprünün `127.0.0.1` portuna erişir; köprü portunu
internete açmanız gerekmez.

## Ön koşullar

- Ayrı bir SSH kullanıcısı; ana dizinine yazma yetkisi. Root/sudo gerekmez.
- SSH sunucusunda TCP forwarding açık olmalı (`AllowTcpForwarding yes` veya
  kullanıcıya sınırlandırılmış eşdeğer ayar).
- Uzak sunucuda `curl`, `python3` (3.10+), `java` ve kullanılan SHA aracı.
- Minecraft 1.20–1.21 için Java 21+, 26.x için Java 25+.
- SSH kullanıcısının yalnızca yöneteceği oyun dosyalarına erişmesi önerilir.

## Otomatik akış

1. Kullanıcı Minecraft EULA'sını açıkça kabul eder.
2. Panel seçilen **tam sürüm** için resmî dağıtımı çözer. Paper için yalnızca
   STABLE derleme seçilir; başka Minecraft sürümüne sessiz geçiş yapılmaz.
3. `$HOME/ssp-servers/<sunucu-kimliği>` yeni oluşturulur. Dizin zaten varsa
   kurulum durur; dünyalar veya mevcut sunucu dosyaları üzerine yazılmaz.
4. JAR dosyası HTTPS ile indirilir. Paper SHA256, Vanilla resmî SHA1 dosya özeti
   kontrol edilir. Fabric launcher API'si özet sağlamadığı için o dosya HTTPS
   üzerinden doğrulanır; bu sınır kurulum planında görünür.
5. `start.sh`, kabul edilmiş `eula.txt`, oyun dosya dizinleri oluşturulur.
6. SSP Python süreç köprüsü ve yalnız kullanıcıya açık `.ssp-env` dosyası
   **SFTP** ile yüklenir. Anahtarlar komut satırına, işlem geçmişine veya günlüğe
   eklenmez. Her sunucuya ayrı köprü portu atanır.
7. Köprü `nohup` ile localhost üzerinde başlar; SSH tüneli üzerinden kimlik
   doğrulamalı `/state` isteğiyle hazır olduğu denetlenir. Dünya otomatik açılmaz;
   panelde **Başlat** kullanılır.
8. Dağıtımda derlenmiş `bridge/paper/target/ssp-paper-bridge-0.1.0.jar` varsa
   Paper eklentisi de yüklenir. Yoksa süreç yönetimi çalışır, oyun içi sağlayıcı
   kurulumu için [BRIDGE.md](BRIDGE.md) adımları gerekir.

Otomatik kurulum Paper, Fabric ve Vanilla içindir. Forge/NeoForge, Valheim,
Terraria ve Rust için otomatik kurulum bildirilmez; manuel kurulum planı ve
köprü protokolü genişletme noktası sunulur. Oyun sağlayıcısı olmadan oyuncu,
ping, envanter veya sohbet verisi üretilmez.

Manuel dağıtım için oyunun resmî kılavuzunu izleyin; dosyaları ayrı bir dizine
kurup SSP köprü sözleşmesine uygun oyun sağlayıcısını bağlayın:

- [Valheim resmî dedicated server kılavuzu](https://www.valheimgame.com/support/a-guide-to-dedicated-servers/)
- [Rust: Facepunch sunucu kurulum kılavuzu](https://wiki.facepunch.com/rust/creating-a-server)
- [Terraria: resmî sunucu indirmesi](https://terraria.org/)

Bu oyunlar için Python köprüsünün Minecraft'a özgü `stop`/başlatma davranışını
oyuna uyarlayan bir süreç sağlayıcısı gerekir; seçim listesinde görünmeleri
hazır canlı entegrasyon bulunduğu anlamına gelmez.

Kısmi indirme/kurulum hatası bir hata olarak kaydedilir. Oluşmuş dizin
kendiliğinden silinmez. İçeriğini SSH ile kontrol edip koruyun; temiz bir kurulum
için yeni sunucu ekleyin. `.ssp-bridge.log` ve `.ssp-bridge.pid` uzak kurulum
dizinindedir. Köprü yeni oturumlarda yaşamaya devam eder; makine yeniden
başlatıldığında otomatik başlama için [systemd örneğini](BRIDGE.md#kalıcı-servis)
kullanın.

## Hazır kurulu sunucu

Mevcut dünyayı taşımadan köprüyü oyun dizinine yerleştirin. Başka bir systemd,
screen veya hosting hizmetinin çalıştırdığı oyunu önce düzgünce kapatın; aynı
dünya iki işlemle açılmamalıdır. Köprünün güç/komut yönetimi yalnızca kendisinin
başlattığı süreçte çalışır. Dışarıdan çalışan oyun için güç düğmesi başarı
taklidi yapmaz. SSH dışındaki bağlantı seçeneği, yönetici tarafından tanımlanmış
TLS doğrulamalı bir HTTPS köprüsüdür. Uzak düz HTTP kabul edilmez.

## Kullanılan resmî sözleşmeler

- [ssh2 Client, hostVerifier ve forwardOut](https://github.com/mscdex/ssh2#client-methods)
- [Paper indirme servisi ve zorunlu User-Agent](https://docs.papermc.io/misc/downloads-service/)
- [Paper Java gereksinimleri](https://docs.papermc.io/paper/getting-started/)
- [Fabric sunucu launcher](https://fabricmc.net/use/server/)
- [Fabric Meta API](https://github.com/FabricMC/fabric-meta/blob/master/README.md)
- [Minecraft EULA](https://www.minecraft.net/eula)

## Hazır kurulu Minecraft sunucusu

Yeni bağlantıda önce mevcut sunucu seçilir. Bağımsız doğrulanmış SSH parmak iziyle `bridge/discover.py` kodu standart girdiden verilen seçeneklerle tek sefer çalışır. Ana dizinde sınırlı tarama yapar veya seçilen mutlak dizini okur; oyun başlatmaz, Java kurmaz, EULA değiştirmez ve sunucu dosyalarını yeniden oluşturmaz. RAM, JVM bellek sınırı, disk, süreç/durum protokolü, oyuncu geçmişi ve JAR metadata verilerini ayrı kaynaklar olarak raporlar.

Kayıtların geçmiş kaynağı yoksa oyuncu toplamı sıfır uydurulmaz. Dünya geçmişi varsa benzersiz UUID'ler kullanılır; yoksa varsa önbellek kaynağı ayrıca belirtilir. Tarama izni veya durum protokolü yetersizse açık/kapalı durumu bilinmiyor kalır. Bu anlık görüntü panelde Yeniden tara ile yenilenir; oyun içi sohbet ve envanter sağlayıcısının yerini almaz.

NeoForge yeni kurulumda resmi Maven metadata dosyasından Minecraft sürümüne uygun kararlı yükleyici seçilir. Installer SHA512 özeti doğrulanır, `--installServer` çalıştırılır ve gerçek `unix_args.txt` ile başlatıcı oluşturulur. Bu adımlar mevcut sunucu içe aktarımında çalışmaz. [Resmi NeoForge kurulumu](https://docs.neoforged.net/user/docs/server/).

Modrinth/CurseForge katalogları, zorunlu bağımlılıklar ve hazır sunucuda kalıcı köprü gerektirmeyen mod görevi için [MODS.md](MODS.md) belgesine bakın.
