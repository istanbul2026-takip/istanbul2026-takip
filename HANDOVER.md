# Devir notu / Handover

Bu depo iki sayfayı yayınlar (Cloudflare Pages, proje `istanbul2026-takip`):

- Herkese açık: https://istanbul2026-takip.pages.dev
- Kulüp (Tarz Dans Spor Kulübü): https://istanbul2026-takip.pages.dev/tarz/

## Veri
- **Saatler: marX** (organizasyonun canlı sayfası, ana kaynak) — `scripts/marx.mjs` okur, düzeltme yapmaz.
  Tur saatleri `r`, prova/ödül/ara saatleri `x` olarak `live` dalındaki `live.json`'a her dakika yazılır.
  Telefonlar bu dosyayı her dakika çeker (deploy gerekmez).
- **Yarışmalar, turlar, kayıtlar, takımlar: WDSF** — `scripts/scrape.mjs`. Gündüz 3 dk, gece 10 dk.
  Değişiklik olunca sayfa yeniden derlenip Cloudflare'e yüklenir.
- WDSF ile marX farklıysa satırda küçük "WDSF 08:30" notu çıkar; hangisinin doğru olduğuna site karar vermez.

## Çalışan işler (GitHub Actions)
- `loop.yml` "Live updater": ~5 sa 40 dk çalışır, bitince kendini yeniden başlatır (15 Kasım 22:00 UTC'ye kadar).
  Kod değişince çalışan kopyayı iptal et (`gh run cancel <id>`); iptal yeni kodla yenisini başlatır.
- `update.yml`: main'e her push'ta derler ve yayınlar.

## Kulüp sayfası
- `club/tarz.json`: takım adı kuralı (`Tarz`), ek takımlar (Secret, Marvellous), ek sporcular, **hoca notları** (`notes`).
- `scripts/club.mjs`: kulübün kayıtlarını her derlemede WDSF verisinden yeniden çıkarır.
- Sıkışık geçiş: aynı sporcunun farklı yarışmalardaki turları **ve sahne provaları** arasında 15 dk'dan az / çakışma.
  Bütün çiftler karşılaştırılır; bağımsız bir Python hesabıyla birebir doğrulandı (marX saatleriyle 69 kişi-çift).
- "Bitti" işaretleri sadece o telefonda saklanır.

## Antrenör araçları (11 Kasım gecesi eklendi)
- **Saat değişiklikleri**: `loop.mjs` her dakika marX'ın önceki haliyle farkını alır (`marxDiff`), `live.json`'a `chg`
  (değişiklik günlüğü, en çok 600 kayıt) ve `chg0` (günlüğün başladığı an) yazar. Sayfa bunu "eski → yeni" olarak
  listeler, satırda "↻ önce 10:11" gösterir. Saatlere dokunmaz. Geri alınan değişiklik gösterilmez. Günlük ile ekrandaki
  saat uyuşmuyorsa (bir dakikalık fark) hiçbir şey göstermez. `chg` olmayan eski akışta bölüm hiç çıkmaz.
- **Günü paylaş**: seçili gün/sporcu için düz metin (telefonun paylaş menüsü; yoksa panoya kopyalar).
- **Ekran açık**: sayfa açıkken ekran kapanmaz (Wake Lock; desteklemeyen tarayıcıda düğme görünmez).
- **＋ Not**: hocanın kendi notu, sadece o telefonda (`tarz-mynotes`). Herkese görünecek not hâlâ `club/tarz.json`.
- **Kayıtların korunması**: bitti işaretleri artık saate değil turun/provanın kendisine bağlı (WDSF saati değişince
  kaybolmaz; eski anahtarlar da tanınır). Her kayıttan önce depodan yeniden okunur (iki sekme birbirini ezmez).
  Sayfa kendini yenilediğinde ya da telefon sekmeyi boşalttığında seçili gün, kaydırma yeri, açık kutular ve
  "ekran açık" 30 dk içinde geri gelir (`sessionStorage`). Tarayıcı kayıt tutmuyorsa (gizli sekme) uyarı çıkar.
- Sınamalar: `tests/` (bkz. `tests/README.md`).
- **Gerçek iPhone'da elle bakılacaklar** (WebKit burada sınanamadı): ＋ Not penceresi ve saat seçici, Günü paylaş →
  WhatsApp, Ekran açık, bir turu işaretleyip sayfayı kapat-aç.

## Çıkış sırası ve hakemler (11 Kasım sabahı eklendi)
- Kaynak: marX'ın her kategori için yayınladığı `<kategoriId>.json` (viewer'da kategoriye basınca açılan veri).
  `timetable.json`'daki `categoryId` ile `wdsfId` eşleşir (`fetchMarx().cat`, JSON'a yazılmaz).
  WDSF'de çıkış sırası ve hakem yok (Officials sayfasında sadece Chairperson ve DJ var).
- `scripts/order.mjs` kategori dosyasını küçültür: hakemler `j` [harf, ad, ülke], diğer görevliler `o`, start numaraları `n`,
  çıkış sırası `h` {turNo: [[dans, [startNo...]], ...]} (heat sırasıyla). `loop.mjs` bunu `live` dalındaki `order.json`'a yazar
  (~25 KB; bugün biten olmayan kategoriler ~100 sn'de bir, diğerleri 20 dk'da bir yenilenir; değişmezse 10 dk'da bir kalp atışı).
- Sayfa `order.json`'ı her dakika çeker (`pullOrder`). Yarışma penceresinde "Hakemler" ve "Çıkış sırası" (tur başına açılır liste,
  takip edilenler ★), kayıt satırlarında "Tur · №322 · sıra 3/3"; kulüp sayfasında satırda ve "Günü paylaş" metninde sporcunun
  start no'su ve sırası. İsim eşleşmesi büyük/küçük harf, aksan ve kelime sırasından bağımsız; bulunamazsa ya da birden fazla
  eşleşirse hiçbir şey gösterilmez (tahmin yok).
- marX bir turun sırasını turdan kısa süre önce giriyor; yayınlanmayan tur için sayfada "henüz yayınlanmadı" yazar.
  Hakem paneli de kategori başladıkça doluyor (11 Kasım 09:00'da 21 kategoride vardı).
- İlk gün sınanmadı: gerçek iPhone'da ve gerçek WDSF isimleriyle (takım adları, düetler) kulüp satırlarındaki etiketlere bak.

## Bilinen noktalar
- marX 10 Kasım 22:21'de saatleri 2 saat ileri yayınladı, 23:53'te geri aldı. Site her zaman marX'ı olduğu gibi gösterir.
- "Ege solo" (13 Kasım 09:55) WDSF'de ve marX'ta yok; hoca notu olarak duruyor.
- Defter ile farklar: Jazz Solo Junior I Final 19:22 (defter 19:52), Modern Duo Adult Yarı Final 10:33 (defter 10:30).
