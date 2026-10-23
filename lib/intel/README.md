# Intel katmanı (öğrenen analiz)

Hedef: sadece Misli oranına bakmayan, skor durumu + istatistik + (ileride) haber/form/oyuncu sinyali birleştiren canlı akıl.

## Şu an

- `brain.mjs` — skor prior’u piyasadan önce gelir
- `lessons.json` — hatalı tip kalıpları diske yazılır (MS X @5.59 / %75 gibi)
- Canlı öneriler `liveTips.mjs` içinde bu beyinden geçer

## Sonraki katmanlar (plan)

1. **Form & tempo** — son maç xG / gol temposu (açık veri kaynakları)
2. **Oyuncu** — sakatlık, kadro, kırmızı kart zinciri
3. **Haber** — transfer / disiplin (yalnızca güvenilir ajans; cafe spam değil)
4. **Geri bildirim** — kullanıcı “yanlıştı” işaretleyince lesson’a yaz

Acele yok: her katman skor-öncelikli çekirdeği bozmadan eklenir.
