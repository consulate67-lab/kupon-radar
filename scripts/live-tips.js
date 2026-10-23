import fs from 'fs'

const headers = {
  'User-Agent': 'Mozilla/5.0',
  Accept: 'application/json',
  Origin: 'https://www.misli.com',
  Referer: 'https://www.misli.com/',
}

async function getLive(sport) {
  const url = `https://apivx.misli.com/api/web/v1/sportsbook/event/0?sportType=${sport}&betType=LIVE`
  const r = await fetch(url, { headers })
  return r.json()
}

function deVig(outcomes) {
  const inv = outcomes.map((o) => 1 / o.od)
  const s = inv.reduce((a, b) => a + b, 0)
  return inv.map((x) => x / s)
}

function pickBest(outcomes) {
  if (!outcomes?.length) return null
  const probs = deVig(outcomes)
  let best = 0
  for (let i = 1; i < probs.length; i++) if (probs[i] > probs[best]) best = i
  return { ...outcomes[best], prob: probs[best] }
}

function analyzeMatch(m) {
  const tips = []
  const total = m.hg + m.ag
  const min = m.min ?? 0
  const period = m.period || ''
  const late = min >= 75 || /SECOND_HALF/i.test(period) && min >= 70
  const ht = /HALF_TIME/i.test(period)
  const first = /FIRST_HALF/i.test(period)

  const find = (re) => m.markets.find((x) => re.test(x.n))
  const ms = find(/^Maç Sonucu$/i)
  const kg = find(/^Karşılıklı Gol$/i)
  const cs = find(/^Çifte Şans$/i)
  const ous = m.markets.filter((x) => /^Altı\/Üstü/i.test(x.n) && !/Ev Sahibi|Deplasman|İlk Yarı|Korner|Kart/i.test(x.n))
  const nextGoal = find(/Sonraki Gol|Bir Sonraki Gol|Next Goal/i)
  const iy = find(/^İlk Yarı Sonucu$/i)

  // Context
  tips.push({
    kind: 'DURUM',
    text: `${m.abbr || ''} ${min ? min + "'" : ''} · skor ${m.score} · toplam gol ${total}${m.red?.[0] || m.red?.[1] ? ` · kırmızı ${m.red[0]}-${m.red[1]}` : ''}`,
  })

  if (ms) {
    const outs = ms.o.filter((o) => o.od >= 1.01)
    const fav = pickBest(outs)
    const home = outs.find((o) => o.n === '1')
    const draw = outs.find((o) => o.n === '0' || o.n === 'X')
    const away = outs.find((o) => o.n === '2')
    if (fav && fav.prob >= 0.55 && fav.od <= 2.4) {
      tips.push({
        kind: 'MS',
        pick: fav.n === '1' ? 'MS 1' : fav.n === '2' ? 'MS 2' : 'MS X',
        odds: fav.od,
        text: `Canlı favori ${fav.n === '1' ? m.home : fav.n === '2' ? m.away : 'beraberlik'} (~%${Math.round(fav.prob * 100)}). Skor temposu ve kalan süreyle uyumlu.`,
      })
    }
    if (late && total >= 1 && draw && draw.od >= 1.5 && draw.od <= 4.5 && m.hg === m.ag) {
      tips.push({
        kind: 'MS',
        pick: 'MS X',
        odds: draw.od,
        text: `Geç dakika eşitlik: beraberlik fiyatı canlıda değerlendirilebilir.`,
      })
    }
    if (late && Math.abs(m.hg - m.ag) >= 2) {
      const lead = m.hg > m.ag ? home : away
      if (lead && lead.od >= 1.05 && lead.od <= 1.45) {
        tips.push({
          kind: 'MS',
          pick: m.hg > m.ag ? 'MS 1' : 'MS 2',
          odds: lead.od,
          text: `2+ fark ve geç dakika: lideri tutmak düşük oranlı ama yüksek olasılıklı canlı tercih.`,
        })
      }
    }
  }

  if (cs) {
    const outs = cs.o
    const map = Object.fromEntries(outs.map((o) => [o.n, o.od]))
    // 1 ve 0 = 1X, etc.
    if (m.hg >= m.ag && map['1 ve 0'] && map['1 ve 0'] <= 1.55) {
      tips.push({
        kind: 'ÇŞ',
        pick: '1X',
        odds: map['1 ve 0'],
        text: `Ev önde/denk: 1X ile risk azaltılabilir.`,
      })
    }
    if (m.ag >= m.hg && map['0 ve 2'] && map['0 ve 2'] <= 1.55) {
      tips.push({
        kind: 'ÇŞ',
        pick: 'X2',
        odds: map['0 ve 2'],
        text: `Dep önde/denk: X2 güvenli canlı seçenek.`,
      })
    }
  }

  if (kg) {
    const varO = kg.o.find((o) => /Var/i.test(o.n))
    const yokO = kg.o.find((o) => /Yok/i.test(o.n))
    if (m.hg > 0 && m.ag > 0 && yokO) {
      tips.push({
        kind: 'KG',
        pick: 'KG Var (kapandı/yaşandı)',
        odds: null,
        text: `Karşılıklı gol oldu (${m.score}). KG Var artık sonuçlandı; başka piyasalara bak.`,
      })
    } else if ((m.hg === 0 || m.ag === 0) && total >= 1 && varO && varO.od <= 2.2) {
      tips.push({
        kind: 'KG',
        pick: 'KG Var',
        odds: varO.od,
        text: `Tek taraflı skor ${m.score}: diğer tarafın golü için KG Var hâlâ açık.`,
      })
    } else if (total === 0 && late && yokO && yokO.od <= 1.8) {
      tips.push({
        kind: 'KG',
        pick: 'KG Yok',
        odds: yokO.od,
        text: `0-0 ve geç dakika: KG Yok canlıda güçleniyor.`,
      })
    } else if (total === 0 && !late && varO && varO.od >= 1.4 && varO.od <= 2.1) {
      tips.push({
        kind: 'KG',
        pick: 'KG Var',
        odds: varO.od,
        text: `Erken/orta 0-0: tempo gelirse KG Var değeri olabilir.`,
      })
    }
  }

  for (const ou of ous.slice(0, 3)) {
    const line = parseFloat((ou.n.match(/(\d+[.,]\d+)/) || [])[1]?.replace(',', '.'))
    if (!Number.isFinite(line)) continue
    const alt = ou.o.find((o) => /Alt/i.test(o.n))
    const ust = ou.o.find((o) => /Üst/i.test(o.n))
    const remain = Math.max(0, 90 - min)
    if (total > line && alt) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line} (geçti)`,
        odds: null,
        text: `Toplam ${total} > ${line}: Üst çizgisi geçildi.`,
      })
    } else if (total === Math.floor(line) && late && alt && alt.od <= 1.7) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        text: `Skor ${m.score}, çizgi ${line}, kalan ~${remain} dk: Alt tarafı güçleniyor.`,
      })
    } else if (total < line - 0.5 && !late && ust && ust.od >= 1.35 && ust.od <= 2.3) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line}`,
        odds: ust.od,
        text: `Gol potansiyeli / düşük skor: Üst ${line} canlı fiyatı izlenmeli.`,
      })
    } else if (late && total < line && alt && alt.od <= 1.55) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        text: `Geç dakika, toplam ${total}/${line}: Alt favori.`,
      })
    }
  }

  if (ht && iy) {
    tips.push({
      kind: 'İY',
      pick: 'İY kapandı',
      odds: null,
      text: `Devre arası: İlk yarı piyasaları kapandı. 2. yarı MS / AÜ / KG’ye odaklan.`,
    })
  }

  if (first && min <= 20 && total === 0) {
    tips.push({
      kind: 'TEMPO',
      pick: 'Bekle / Üst izle',
      odds: null,
      text: `İlk 20' ve 0-0: tempo ölç; erken pahalı favoriye girme, gol sonrası odds kayması bekle.`,
    })
  }

  if (m.sport === 'BB') {
    tips.push({
      kind: 'BASKET',
      pick: 'MS / Toplam',
      odds: null,
      text: `Basket canlı: skor ${m.score}. Çeyrek/periyot farkı ve toplam sayı çizgisine göre MS veya Alt/Üst değerlendir.`,
    })
  }

  // unique tips by kind+pick
  const seen = new Set()
  const uniq = []
  for (const t of tips) {
    const k = t.kind + '|' + (t.pick || t.text)
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(t)
  }
  return uniq
}

const [soccer, basket] = await Promise.all([getLive('SOCCER'), getLive('BASKETBALL')])

function pack(data, sport) {
  let league = 'Diğer'
  const out = []
  for (const e of data.data?.e || []) {
    if (!e.m?.length) {
      if (e.p?.[0]?.n) league = e.p[0].n
      continue
    }
    if (!e.l || !e.sc) continue
    const hg = e.sc.ht?.r ?? 0
    const ag = e.sc.at?.r ?? 0
    out.push({
      id: e.i,
      sport,
      league,
      home: e.p?.[0]?.n,
      away: e.p?.[1]?.n,
      score: `${hg}-${ag}`,
      hg,
      ag,
      min: e.sc.min ?? e.t,
      period: e.sc.s,
      abbr: e.sc.abbr,
      red: [e.sc.ht?.rc || 0, e.sc.at?.rc || 0],
      markets: e.m.map((m) => ({
        n: m.n,
        o: (m.o || []).filter((x) => typeof x.od === 'number').map((x) => ({ n: x.n, od: x.od })),
      })),
    })
  }
  return out
}

const all = [...pack(soccer, 'FB'), ...pack(basket, 'BB')]

function interest(m) {
  let s = (m.hg + m.ag) * 2
  if ((m.min || 0) >= 70) s += 5
  if (m.markets.some((x) => /^Maç Sonucu$/i.test(x.n))) s += 2
  if (m.markets.some((x) => /Altı\/Üstü/i.test(x.n))) s += 2
  if (m.sport === 'FB') s += 1
  return s
}

all.sort((a, b) => interest(b) - interest(a))
const top = all.slice(0, 14).map((m) => ({
  ...m,
  tips: analyzeMatch(m),
  url: `https://www.misli.com/iddaa/${m.id}`,
}))

fs.writeFileSync('D:/idaaaa/tmp-live-tips.json', JSON.stringify({ at: new Date().toISOString(), count: all.length, top }, null, 2))

for (const m of top) {
  console.log('\n===', m.sport, '|', m.league)
  console.log(`${m.home} ${m.score} ${m.away} · ${m.abbr || ''} ${m.min ?? ''}'`)
  for (const t of m.tips) {
    const odd = t.odds != null ? ` @${t.odds}` : ''
    const pick = t.pick ? ` → ${t.pick}${odd}` : ''
    console.log(`  [${t.kind}]${pick}: ${t.text}`)
  }
}
console.log('\nTOTAL_LIVE', all.length)
