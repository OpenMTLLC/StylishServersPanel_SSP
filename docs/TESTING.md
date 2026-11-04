# Doğrulama

SSP v0.2.0 Node.js 24 ve Python 3.11 ile doğrulandı. Paper eklentisi önceki sürümde Java 21 hedefiyle derlendi; eklenti kaynakları bu sürümde değişmedi.

- `npm test`: 32 test. Oturum/yetkiler, CSRF, davetler, geri alma, özel eşya verisi, katalog sağlayıcıları, CurseForge anahtarları ve indirme izinleri, NeoForge sürüm/özet doğrulaması, hazır sunucu içe aktarımının kurulum planını atlaması, SSH üzerinden stdin veri aktarımı.
- `python -m unittest discover -s tests -p '*_test.py' -v`: 26 test. Keşfin oyun dosyalarını değiştirmemesi, Minecraft durum protokolü, oyuncu geçmişi, mod ve zorunlu bağımlılıklarının tek işlemde hazırlanması, dosya özetleri, hata halinde yeni dosyaları geri alma, mevcut modun ikinci kopyasını engelleme, süreç ve dosya güvenliği. Sembolik bağlantı testi Windows izin farkı nedeniyle yerelde atlanır; Linux GitHub Actions üzerinde çalışır.
- `npm run build`: TypeScript kontrolü, Vite üretim arayüzü ve Node sunucusu derlemesi.
- `mvn -B -f bridge/paper/pom.xml package`: Paper API 1.21.4 için Java 21 hedefli eklenti.

Gerçek Modrinth API'sinden Fabric, NeoForge ve Paper katalogları sorgulandı. Ayrı bir test dizinine gerçek Waystones, Fabric API ve Balm dosyaları tek kurulum çağrısıyla indirilip resmi özetleri doğrulandı; oyun başlatılmadı. NeoForge 1.21.1 için resmi Maven metadata ve SHA512 dosyası sorgulanarak uyumlu dağıtım çözüldü; gerçek uzak kurulum çalıştırılmadı. CurseForge canlı API anahtarı sağlanmadığı için sağlayıcının başlık, sürüm/yükleyici filtresi, izin ve dosya kuralları kontrollü API yanıtlarıyla test edildi.

Masaüstü (1440 px) ve mobil (390 px) arayüz Edge/Chromium ile kontrol edildi. Ana metin 16 px, menü metni 15 px olarak ölçüldü; CurseForge eksik anahtar durumu, NeoForge seçimi ve mevcut sunucuda kurulum ekranını atlama akışı geçti. Sayfa taşması ve JavaScript hatası görülmedi. Hazır sunucu sihirbazında SSH keşfi ve içe aktarım ekranı kontrollü yanıtlarla doğrulanır; bu, canlı bir oyun sunucusunda test yapıldığı anlamına gelmez. SSH aktarımı ayrıca yerel gerçek SSH protokol test sunucusuyla denetlenir.

Canlı uzak sunucu veya oyun dünyası sağlanmadı. Docker daemon yerelde bulunmadığından imaj derlemesi çalıştırılmadı. Fabric/Forge/NeoForge sohbet ve canlı envanter için uygun oyun sağlayıcısı gerekir; destek matrisi [BRIDGE.md](BRIDGE.md) içindedir.
