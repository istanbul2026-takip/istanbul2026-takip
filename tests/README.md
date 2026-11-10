# Sınamalar / Tests

Yayına almadan önce çalıştırılan sınamalar. Başsız Chrome (Python Playwright) ve gerçek veri kullanır.

Hazırlık (yollar `/tmp/t` ve `/tmp/dist` olarak sabit; farklıysa dosyaların başındaki yolları değiştir):

    mkdir -p /tmp/t && cp tests/* /tmp/t/
    # data/last.json: Actions önbelleğindeki son WDSF verisi (depoda tutulmaz)
    node tests/marx-diff.test.mjs            # marX fark hesabı + /tmp/t/marx-now.json üretir
    node tests/build-local.mjs /tmp/dist     # yeni sürüm
    git stash; node tests/build-local.mjs /tmp/dist-base; git stash pop   # karşılaştırma için önceki sürüm

Sonra:

    python3 /tmp/t/suite.py /tmp/dist   # saat değişiklikleri, paylaşım, ekran açık, notlar, EN, koyu tema
    python3 /tmp/t/mem.py               # iki sekme, yeniden yükleme, saat kayması, depolama kapalı, telefon profilleri
    python3 /tmp/t/ab.py                # önceki sürümle 128 görünümün metin karşılaştırması (fark 0 olmalı)

`mock.mjs`: `scripts/loop.mjs`'i sahte GitHub + marX ile, hızlandırılmış saatle çalıştırır
(`SCEN=a|b|c node --import /tmp/t/mock.mjs scripts/loop.mjs`; `marx-raw.json` marX'ın ham dosyasıdır).

Not: iOS Safari'nin kendi motoru (WebKit) bu ortamda yok; telefon profilleri Chromium motorunda çalışır.
Gerçek iPhone'da elle bakılması gerekenler HANDOVER.md'de.
