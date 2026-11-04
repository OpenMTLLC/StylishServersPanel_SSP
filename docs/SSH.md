# Mevcut sunucuya bağlantı

SSP, uzak makineye panel API'sinden bağlanır. İlk girişte ve her yeni oturum açılırken uzak bağlantı doğrulanır. SSP üzerinden yeni oyun sunucusu oluşturulmaz; mevcut oyun dosyaları okunur.

## Bağlantı türleri

Giriş formunda akordeon seçenekleri bulunur:

- **SSH · Parola**: adres, port, SSH kullanıcısı, parola ve SHA256 sunucu parmak izi.
- **SSH · Özel anahtar**: aynı bilgiler ve parola yerine SSH özel anahtarı. Bu sürümde şifrelenmiş özel anahtar için ayrı passphrase alanı bulunmaz.
- **HTTPS · SSP Bridge**: daha önce kurulmuş köprünün TLS doğrulamalı URL'si ve erişim anahtarı. Uzak düz HTTP kabul edilmez; localhost HTTP test/yerel bağlantı için kullanılabilir.

SSH bilgileri `data/` içindeki panel veritabanında AES-256-GCM ile şifrelenir. Tarayıcı depolamasına yazılmaz. İlk **Sunucu parmak izini al** isteği yalnızca anahtarı öğrenir; parola göndermez ve uzak komut çalıştırmaz. Bu değeri bağımsız kaynaktan doğrulayın:

```sh
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub -E sha256
```

Sunucu başka anahtar algoritması kullanıyorsa ilgili `ssh_host_*_key.pub` dosyasını kontrol edin. Parmak izi eşleşmeden kimlik bilgileri gönderilmez. Anahtar değişirse bağlantı reddedilir.

## İlk keşif

SSH kullanıcısının mevcut oyun dizinini okuma izni ve uzak makinede Python 3.10+ gerekir. **Mevcut sunucuları bul** ile adaylar görüntülenir. Otomatik arama sunucuyu bulamazsa tam mutlak dizini belirtin. Birden fazla kurulum varsa doğru dizini seçin.

`bridge/discover.py`, standart girdiden verilen seçeneklerle tek seferlik salt okunur keşif yapar: oyun/yükleyici sürümü, fiziksel RAM, JVM bellek sınırı, disk, süreç/durum protokolü, oyuncu geçmişi ve JAR metadata bilgileri. Java/EULA/oyun dosyaları kurulmaz veya değiştirilmez.

Doğrulanamayan durum veya sayaçlar bilinmiyor olarak kalır. Toplam oyuncu dünya geçmişindeki benzersiz UUID'lerden hesaplanır; yalnızca kullanıcı önbelleği okunabiliyorsa bunun bir tahmin olduğu belirtilir. Diskteki modlar ile çalışma zamanında yüklenmiş modlar ayrı bilgi kaynaklarıdır.

İlk görüntü kaydedilir. Sonraki giriş, uzak kimlik bilgilerini doğrular ve görüntüyü tekrar kullanır. **Genel Bakış → Yeniden tara** güncel bilgileri ister. SSH keşfi, oyun içi sohbet ve envanter sağlayıcısının yerini almaz.

## Yönetim bağlantısı

Oyuncu, sohbet, envanter ve süreç yönetimi için [SSP oyun köprüsünü](BRIDGE.md) mevcut sunucuya bağlayın. SSH tüneli köprünün localhost portuna erişir; `AllowTcpForwarding` açık olmalıdır. Köprü portunu internete açmak gerekmez. HTTPS bağlantısı, yönetici tarafından TLS ile yayınlanmış mevcut köprüye erişir.

Başka bir systemd/screen/hosting servisiyle çalışan oyun, köprü tarafından başlatılmış gibi kabul edilmez. Aynı dünyayı ikinci bir süreçle açmayın. Güç/komut yönetimi için oyun sürecini ilgili sağlayıcıya bağlayın.

Mod kurulumu mevcut oyun dizinindeki modları ve zorunlu bağımlılıklarını yönetir; oyun sunucusunu yeniden kurmaz. [Modrinth ve CurseForge ayrıntıları](MODS.md).
