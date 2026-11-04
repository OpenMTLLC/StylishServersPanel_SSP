# Güvenlik bildirimi

Açık GitHub issue'larına parola, SSH anahtarı, köprü tokenı veya davet kodu eklemeyin. GitHub deposundaki Private vulnerability reporting etkinse özel bildirim kullanın; değilse önce ayrıntıları içermeyen bir issue ile özel iletişim yolu isteyin.

Paneli varsayılan loopback arayüzünde çalıştırın. İnternete açarken HTTPS reverse proxy kullanın ve `SSP_SECURE_COOKIE=true` ayarlayın. SSH sunucusunun SHA256 parmak izini bağımsız kaynaktan doğrulayın. `data/master.key` ile veritabanını birlikte ve erişimi kısıtlı olarak yedekleyin. Bu anahtar aynı klasörde bulunduğundan disk erişimi olan saldırgana karşı koruma sağlamaz.

Oyun sunucusu için kısıtlı bir işletim sistemi hesabı kullanın. Oyun köprüsünü herkese açık ağa bağlamayın; SSH tüneli üzerinden erişin. Modlar ve eklentiler sunucuda kod çalıştırır; yalnızca güvendiğiniz projeleri yükleyin.

Özel erişim sekmeleri ve işlem yetkileri API'de uygulanır. Erişim kodu yöneticisi kendi yetkilerinden fazlasını veremez; kod iptali ilişkili üyeliği kaldırır. Gerçek mod çantası desteği oyuna özel sağlayıcı gerektirir. SSP bağımsız güvenlik denetiminden geçtiğini iddia etmez.
