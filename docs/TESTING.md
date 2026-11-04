# Doğrulama

SSP v0.3.0, Node.js 24 ve Python 3.11 ile doğrulandı. Paper eklentisinin Java 21 kaynakları bu sürümde değişmedi.

- `npm test`: 34 test. Zorunlu uzak bağlantı, davetsiz kendi hesabı oluşturma, kodla giriş, tekrar bağlantı doğrulama, ilk keşfin önbelleği, özel sekme/işlem izinleri, veri gizleme, yetki yükseltmesini engelleme, anında erişim iptali, CSRF, parola boşlukları, geri alma ve çakışma denetimi, özel eşya verisi ve şifreleme. Katalog, NeoForge özet ve SSH protokol testleri de çalışır.
- `python -m unittest discover -s tests -p '*_test.py' -v`: 26 test. Salt okunur keşif, Minecraft durum protokolü, oyuncu geçmişi, atomik mod/bağımlılık indirmesi, özet denetimi, dosya ve süreç güvenliği. Bir sembolik bağlantı testi Windows izin farkı nedeniyle yerelde atlanır; Linux CI üzerinde çalışır.
- `npm run build`: TypeScript, Vite arayüzü ve Node sunucusu derlemesi.
- `mvn -B -f bridge/paper/pom.xml package`: Paper 1.21.4 API'si, Java 21 hedefi. GitHub Actions üzerinde ayrıca derlenir.

Arayüz Edge/Chromium üzerinde 390, 768 ve 1440 piksel genişlikte kontrol edildi. Türkçe, İngilizce, Almanca ve Fransızca ilk dil algılama; tercihlerin yenilemede korunması; stabilite modunda animasyonun durması; kendi sunucum/kod modlarının ayrılması; oyuncu ve işlem tabloları; özel yetki seçimleri; mod listesinin sayfadan bağımsız kayması doğrulandı. JavaScript sayfa hatası görülmedi.

Arayüz kontrolleri geçici bir veri dizini ve enjekte edilmiş test uzak bağlantılarıyla yapılır. Test yanıtları `tests/fixtures.ts` içindedir; üretim uygulamasında örnek giriş veya örnek veri API'si bulunmaz. README görüntüsü boş giriş formudur.

Önceki sürümde gerçek Modrinth API'sinden Fabric/NeoForge/Paper kataloğu ve ayrı test dizinine Waystones, Fabric API, Balm indirme/özetleri doğrulandı. Bu sürüm katalog protokolünü değiştirmez. Gerçek CurseForge API anahtarı ve canlı uzak oyun dünyası sağlanmadı; bunlar için kontrollü yanıtlar kullanıldı. Gerçek SSH aktarımı yerel SSH protokol test sunucusunda denetlenir. Docker daemon bulunmadığından yerel imaj derlemesi çalıştırılmadı.

Fabric/Forge/NeoForge oyun içi sohbet ve envanter için uygun oyun sağlayıcısı gerekir; [destek kapsamı](BRIDGE.md) geçerlidir.
