# Kupon Radar (Misli)

Misli.com oranlarıyla çoklu bahis analizi + canlı skor-öncelikli öneriler.

Intel katmanı (`lib/intel/`): skor/kalan süre piyasadan önce gelir; hatalı kalıplar `data/intel/lessons.json` içine yazılır. Hedef: form, oyuncu, haber ve geri bildirimle büyüyen analiz — acele değil, katman katman.

## Çalıştır

```bash
npm install
npm run dev
```

Aç: http://localhost:5174

## Veri kaynağı

- Bülten: `apivx.misli.com/api/web/v1/sportsbook/event/0`
- Tüm marketler: `apivx.misli.com/api/web/v2/sportsbook/event/{id}/single`
- Oyuncu oranları: `play-ratio/event/{id}`

## Analiz edilen piyasalar

Maç Sonucu, Çifte Şans, Alt/Üst, Karşılıklı Gol, Handikap, İlk Yarı, MS+AU / MS+KG kombineleri.

## Not

Bilgi amaçlıdır; bahis tavsiyesi değildir. 18+
