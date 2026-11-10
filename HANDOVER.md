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

## Bilinen noktalar
- marX 10 Kasım 22:21'de saatleri 2 saat ileri yayınladı, 23:53'te geri aldı. Site her zaman marX'ı olduğu gibi gösterir.
- "Ege solo" (13 Kasım 09:55) WDSF'de ve marX'ta yok; hoca notu olarak duruyor.
- Defter ile farklar: Jazz Solo Junior I Final 19:22 (defter 19:52), Modern Duo Adult Yarı Final 10:33 (defter 10:30).
