# Doğrulama

Bu ilk sürüm Node.js 24, Python 3.11 ve Java 21 hedefiyle derlendi.

- `npm test`: 18 test; kimlik doğrulama, CSRF, sunucu üyeliği, yetkiler, davetler, saklama süresi, envanter özel verileri, geri alma çakışmaları, SSH parmak izi ve gerçekten SSH kanalından geçen HTTP isteği.
- `python -m unittest discover -s tests -p bridge_test.py -v`: 7 test; kimlik doğrulama, komut sınırları, dosya güvenliği, mod kaldırma karantinası ve gerçek bir test sürecini başlatma/komut gönderme/düzgün kapatma.
- `npm run build`: TypeScript doğrulaması, Vite üretim arayüzü ve Node sunucu derlemesi.
- `mvn -B -f bridge/paper/pom.xml package`: Paper API 1.21.4 üzerinde Java 21 hedefli JAR üretimi.
- `npm audit`: kurulum sırasında bilinen bağımlılık açığı bulunmadı.

Üretim derlemesi Edge/Chromium üzerinde 1440 px masaüstü ve 390 px mobil görünümde kontrol edildi. Demo ortamında oyuncu arama, çanta envanterini düzenleyip geri alma, 48 karakterli davet oluşturma/iptal etme, fısıltı/komut filtreleri, sunucu değiştirme/güç işlemi ve sunucu ekleme sihirbazı denendi. Tarayıcı JavaScript hatası ve sayfa taşması görülmedi.

Canlı SSH sunucusu veya gerçek oyun dünyası sağlanmadığı için gerçek uzak kurulum ve oyun içi davranış uçtan uca denenmedi. Docker dosyaları hazırlandı; yerelde Docker daemon bulunmadığından imaj derlemesi çalıştırılmadı. Bir çanta sağlayıcısının varlığı, bütün Fabric/Forge modlarının desteklendiği anlamına gelmez; destek matrisi [BRIDGE.md](BRIDGE.md) dosyasındadır.
