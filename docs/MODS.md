# Modrinth ve CurseForge modları

Modlar ekranında sağlayıcıyı seçin. Aramalar seçili sunucunun Minecraft sürümü ve yükleyicisine (Fabric, Forge, NeoForge veya Paper eklentileri) göre yapılır. **Modu ve bağımlılıkları yükle** uyumlu sürümü ve zorunlu bağımlılıklarını birlikte hazırlar; dosya özetleri doğrulanmadan oyun dizinine kurulmaz. İndirilemeyen veya uyumsuz bağımlılık varsa işlem tamamlanmış gibi gösterilmez.

Çalışan oyuna JAR dosyası yazılmaz. Önce oyunu durdurun; kurulumdan sonra kendi süreç yöneticinizden veya SSP köprüsünden yeniden başlatın. İstemcilere de kurulması gereken modları oyuncuların yüklemesi gerekir; sunucudaki kurulum oyuncu bilgisayarlarını değiştirmez.

## CurseForge anahtarı

CurseForge'un resmi API'si `x-api-key` başlığıyla bir geliştirici anahtarı ister. Anahtarı [CurseForge geliştirici konsolundan](https://console.curseforge.com/) alın ve sunucunun **Ayarlar** bölümünde kaydedin. Alternatif olarak panel sürecine `SSP_CURSEFORGE_API_KEY` ortam değişkenini sağlayın. Yerel `.env` kendiliğinden okunmaz; Docker Compose bu ortam değişkenini iletebilir.

Panelden girilen anahtar SQLite içinde şifreli saklanır; API yanıtları anahtarın yalnızca ayarlı olup olmadığını bildirir. Anahtarı sohbet, issue, ekran görüntüsü veya Git deposuna eklemeyin.

Mod yazarı üçüncü taraf dağıtımını kapatmışsa veya CurseForge bir indirme adresi sunmuyorsa tek tıkla indirme kapalıdır. Arayüz nedenini ve varsa resmi proje bağlantısını gösterir; kısıtları aşmak için CDN adresi üretilmez.

## Hazır sunucular

SSH ile algılanıp eklenmiş mevcut sunucularda oyun yeniden kurulmaz. Mod işlemi, oyun dizininde tek seferlik Python göreviyle çalıştırılabilir; kalıcı SSP oyun köprüsü zorunlu değildir. Görev oyun sürecini, açık portu ve dünya kilitlerini kontrol eder. Durduğu doğrulanamayan sunucuda dosya değiştirmez. Diskte önceden bulunan JAR dosyaları listelenir; yalnızca SSP'nin kurup kaydettiği dosyaların kaldırılması yönetilir.

## Kaynaklar

- [Modrinth API](https://docs.modrinth.com/api/)
- [CurseForge API; arama, dosyalar, dağıtım izinleri ve yükleyici türleri](https://docs.curseforge.com/rest-api/)
- [NeoForge sunucu kurulumu](https://docs.neoforged.net/user/docs/server/)
