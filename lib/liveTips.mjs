import {
  filterMarketLean,
  isYouthMatch,
  oddsProbSane,
  remainingMinutes,
  saferThanDraw,
  scoreResultPrior,
} from './intel/brain.mjs'
import { liveTipDelta, peekLeagueContext } from './intel/leagueForm.mjs'

function deVig(outcomes) {
  const inv = outcomes.map((o) => 1 / o.od)
  const s = inv.reduce((a, b) => a + b, 0) || 1
  return inv.map((x) => x / s)
}

function playable(o) {
  return o && typeof o.od === 'number' && o.od >= 1.08 && o.od <= 8
}

function bestSide(outcomes) {
  // Sadece tam 3’lü MS (1/X/2) — eksik piyasada sahte % üretme
  const all = (outcomes || []).filter((o) => typeof o.od === 'number' && o.od >= 1.01)
  const sides = new Set(
    all.map((o) => (o.n === '1' || o.n === 1 ? '1' : o.n === '2' || o.n === 2 ? '2' : o.n === '0' || o.n === 'X' ? 'X' : null)),
  )
  sides.delete(null)
  if (sides.size < 3 && all.length < 3) return null

  const probs = deVig(all)
  let i = 0
  for (let k = 1; k < probs.length; k++) if (probs[k] > probs[i]) i = k
  const pick = { ...all[i], prob: probs[i] }
  if (!playable(pick)) return null
  if (!oddsProbSane(pick.od, pick.prob)) return null
  return pick
}

function pairProbs(a, b) {
  if (!a || !b || typeof a.od !== 'number' || typeof b.od !== 'number') return null
  const [pa, pb] = deVig([a, b])
  return { a: pa, b: pb }
}

/**
 * Basit tempo modeli: maç başı ~2.6 gol / 90 dk varsayımı,
 * anlık skor temposu + kalan süre ile suskun tarafın gol olasılığı.
 */
function silentTeamScoreChance({ min, period, hg, ag, homeRed = 0, awayRed = 0 }) {
  const rem = remainingMinutes(min, period)
  const total = (hg || 0) + (ag || 0)
  const elapsed = Math.max(1, 90 - rem)
  const pace = total / elapsed // gol / dk
  const leaguePace = 2.6 / 90
  const blended = pace * 0.45 + leaguePace * 0.55
  // Suskun taraf genelde tempo payının ~%40'ını alır (geride / kapanan maç)
  let lambdaSilent = blended * rem * 0.42
  // Geç dakika baskısı biraz artar ama 80+ sonrası hızla düşer
  if (min >= 80) lambdaSilent *= 0.55
  else if (min >= 70) lambdaSilent *= 0.75
  // Önde olanın kırmızı kartı → suskun taraf şansı artar
  if (hg > ag && homeRed > awayRed) lambdaSilent *= 1.35
  if (ag > hg && awayRed > homeRed) lambdaSilent *= 1.35
  // Geride olanın kırmızı kartı → şansı düşer
  if (hg > ag && awayRed > homeRed) lambdaSilent *= 0.65
  if (ag > hg && homeRed > awayRed) lambdaSilent *= 0.65
  // P(en az 1 gol) ≈ 1 - e^-λ
  const p = 1 - Math.exp(-Math.max(0.02, lambdaSilent))
  return { p, rem, lambda: lambdaSilent }
}

/**
 * @param {object} m normalized live match with markets [{n,o:[{n,od}]}]
 */
export function buildLiveTips(m) {
  const tips = []
  const total = (m.hg || 0) + (m.ag || 0)
  const min = m.min ?? 0
  const period = m.period || ''
  const late = min >= 70
  const veryLate = min >= 80
  const dying = min >= 85
  const ht = /HALF_TIME/i.test(period)
  const second = /SECOND_HALF/i.test(period) || /2\.Y/i.test(m.abbr || '')
  const first = /FIRST_HALF/i.test(period) || /1\.Y/i.test(m.abbr || '')
  const markets = m.markets || []
  const oneSided = (m.hg > 0 && m.ag === 0) || (m.ag > 0 && m.hg === 0)
  const bothScored = m.hg > 0 && m.ag > 0
  const rem = remainingMinutes(min, period)

  const find = (re) => markets.find((x) => re.test(x.n))
  const findAll = (re) => markets.filter((x) => re.test(x.n))

  tips.push({
    kind: 'DURUM',
    priority: 100,
    text: `${m.abbr || period || 'CANLI'}${min ? ` ${min}'` : ''} · ${m.home} ${m.score} ${m.away} · gol ${total} · ~${rem}' kaldı${
      m.homeRed || m.awayRed ? ` · KK ${m.homeRed || 0}-${m.awayRed || 0}` : ''
    }`,
  })

  if (m.sport === 'basketball' || m.sport === 'BB') {
    return buildBasketTips(m, tips)
  }

  const ms = find(/^Maç Sonucu$/i)
  const kg = find(/^Karşılıklı Gol$/i)
  const cs = find(/^Çifte Şans$/i)
  const ous = findAll(/^Altı\/Üstü \d/i).filter((x) => !/Ev Sahibi|Deplasman|İlk|Korner|Kart/i.test(x.n))
  const nextGoal = find(/Sonraki Gol|Bir Sonraki/i)

  // Piyasa = ciddi konsensüs (tekil cafe yorumu değil)
  const kgVar = kg && (kg.o || []).find((o) => /Var/i.test(o.n))
  const kgYok = kg && (kg.o || []).find((o) => /Yok/i.test(o.n))
  const kgPair = kgVar && kgYok ? pairProbs(kgVar, kgYok) : null
  const silent = oneSided
    ? silentTeamScoreChance({
        min,
        period,
        hg: m.hg,
        ag: m.ag,
        homeRed: m.homeRed,
        awayRed: m.awayRed,
      })
    : null

  if (ht) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 90,
      text: 'Devre arası: İY kapalı. 2. yarı açılışında MS / AÜ / KG oranlarını ilk 2–3 dk izle, acele etme.',
    })
  }

  // ——— KG: skor + kalan süre + piyasa olasılığı ———
  if (bothScored) {
    tips.push({
      kind: 'KG',
      pick: 'KG Var (oldu)',
      odds: null,
      priority: 35,
      text: 'Karşılıklı gol yaşandı. KG kapandı; AÜ / MS / sonraki gol’e kay.',
    })
  } else if (oneSided && silent) {
    const marketVarP = kgPair?.a ?? null
    // Model + piyasa ortalaması (piyasa varsa ağırlıklı)
    const modelP = silent.p
    const pSilent = marketVarP != null ? modelP * 0.55 + marketVarP * 0.45 : modelP

    if (veryLate || (late && pSilent < 0.38)) {
      // 81' 1-0 gibi: KG Var önerme — Yok / Alt / lider MS
      if (playable(kgYok) && (kgPair?.b ?? 0) >= 0.55) {
        tips.push({
          kind: 'KG',
          pick: 'KG Yok',
          odds: kgYok.od,
          priority: 88,
          text: `${min}' ${m.score}: suskun taraf ~%${Math.round(pSilent * 100)} (kalan ~${silent.rem}'). Geç dakika tek taraflı skor → KG Yok ağır basar.`,
        })
      } else {
        tips.push({
          kind: 'STRATEJİ',
          priority: 86,
          text: `${min}' ${m.score}: KG Var istatistiksel olarak zayıf (~%${Math.round(pSilent * 100)}). Lider MS / Alt çizgisine bak; “KG olabilir” deme.`,
        })
      }
    } else if (min < 60 && pSilent >= 0.42 && playable(kgVar) && kgVar.od <= 2.15) {
      tips.push({
        kind: 'KG',
        pick: 'KG Var',
        odds: kgVar.od,
        priority: 72,
        text: `${m.score}, ${min}' · suskun taraf modeli ~%${Math.round(pSilent * 100)}. Erken/orta bölümde KG Var anlamlı; piyasa ${kgVar.od.toFixed(2)}.`,
      })
    } else if (min >= 60 && min < 75 && pSilent >= 0.48 && playable(kgVar) && kgVar.od <= 1.85) {
      // Geç ama piyasa hâlâ kısa fiyatlıysa (ciddi lean)
      tips.push({
        kind: 'KG',
        pick: 'KG Var',
        odds: kgVar.od,
        priority: 70,
        text: `${min}' tek taraflı ama piyasa KG Var’ı kısa tutuyor (@${kgVar.od.toFixed(2)}, model ~%${Math.round(pSilent * 100)}). Nadir istisna.`,
      })
    } else if (playable(kgYok) && pSilent < 0.4) {
      tips.push({
        kind: 'KG',
        pick: 'KG Yok',
        odds: kgYok.od,
        priority: 74,
        text: `${m.score} · suskun taraf düşük (~%${Math.round(pSilent * 100)}). KG Yok modeli destekliyor.`,
      })
    }
  } else if (total === 0) {
    if (dying && playable(kgYok)) {
      tips.push({
        kind: 'KG',
        pick: 'KG Yok',
        odds: kgYok.od,
        priority: 90,
        text: `${min}' 0-0: KG Yok neredeyse kapanış senaryosu.`,
      })
    } else if (late && playable(kgYok) && (kgPair?.b ?? 0) >= 0.58) {
      tips.push({
        kind: 'KG',
        pick: 'KG Yok',
        odds: kgYok.od,
        priority: 84,
        text: `Geç dakika 0-0: piyasa KG Yok ~%${Math.round((kgPair?.b || 0) * 100)}.`,
      })
    } else if (min >= 25 && min < 65 && playable(kgVar) && kgVar.od <= 1.95 && (kgPair?.a ?? 0) >= 0.48) {
      tips.push({
        kind: 'KG',
        pick: 'KG Var',
        odds: kgVar.od,
        priority: 66,
        text: `0-0 orta bölüm: tempo gelirse KG; sadece piyasa ≥~%48 ve oran ≤1.95 iken.`,
      })
    }
  }

  // 0-0 / eşitlik: MS X tuzağına karşı daha az riskli yön (Stoke–Nords dersi)
  const safer = saferThanDraw(m, markets)
  if (safer?.length) tips.push(...safer)

  // ——— MS: skor prior > piyasa (eksik market / sahte % engeli) ———
  if (ms) {
    const outs = ms.o || []
    const home = outs.find((o) => o.n === '1')
    const draw = outs.find((o) => o.n === '0' || o.n === 'X')
    const away = outs.find((o) => o.n === '2')
    const prior = scoreResultPrior(m)
    const fav = filterMarketLean(bestSide(outs), m, outs)
    const youth = isYouthMatch(m)

    // 1) Skor beyni — 85' 2-1 → MS 1, asla MS X
    if (prior) {
      const leadOut = prior.pick === 'MS 1' ? home : prior.pick === 'MS 2' ? away : draw
      const od = playable(leadOut) ? leadOut.od : null
      tips.push({
        kind: od != null ? 'MS' : 'STRATEJİ',
        pick: prior.pick,
        odds: od,
        priority: 92,
        text: `${prior.reason} (güven ~%${Math.round(prior.confidence * 100)}).`,
      })
    }

    // 2) Piyasa lean — X hariç (X sadece skor prior / çok geç)
    if (fav && fav.prob >= 0.55 && fav.side !== 'X') {
      const label = fav.side === '1' ? `MS 1 (${m.home})` : `MS 2 (${m.away})`
      const priorPick = prior?.pick
      const same =
        !priorPick ||
        (fav.side === '1' && priorPick === 'MS 1') ||
        (fav.side === '2' && priorPick === 'MS 2')
      if (same) {
        tips.push({
          kind: 'MS',
          pick: label,
          odds: fav.od,
          priority: prior ? 74 : 76,
          text: `Piyasa lean ~%${Math.round(fav.prob * 100)} (@${fav.od.toFixed(2)}) · skor ile uyumlu. Kalan ~${rem}'.`,
        })
      }
    }

    if (second && Math.abs(m.hg - m.ag) >= 2 && !prior) {
      const lead = m.hg > m.ag ? home : away
      if (playable(lead) && lead.od <= 1.4) {
        tips.push({
          kind: 'MS',
          pick: m.hg > m.ag ? 'MS 1' : 'MS 2',
          odds: lead.od,
          priority: 85,
          text: '2+ fark + 2. yarı: lider yüksek olasılık / düşük oran.',
        })
      }
    }

    // X: yalnız çok geç + eşitlik + süre bitmiş; gençlikte daha geç; kısa X engeli
    const xOk =
      !prior &&
      m.hg === m.ag &&
      playable(draw) &&
      draw.od >= 1.55 &&
      draw.od <= 2.35 &&
      rem <= 12 &&
      min >= (youth ? 85 : 82)
    if (xOk) {
      tips.push({
        kind: 'MS',
        pick: 'MS X',
        odds: draw.od,
        priority: 80,
        text: `${min}' eşitlik, kalan ~${rem}': geç X. Kısa X+süre tuzağı değil.`,
      })
    }

    if (first && min <= 25 && total >= 2 && fav && playable(fav) && fav.od <= 1.7 && fav.side !== 'X') {
      tips.push({
        kind: 'MS',
        pick: fav.side === '1' ? 'MS 1' : 'MS 2',
        odds: fav.od,
        priority: 68,
        text: `Erken tempo yüksek (${total} gol). Favori momentumlu olabilir.`,
      })
    }
  }

  if (cs) {
    const map = Object.fromEntries((cs.o || []).map((o) => [o.n, o]))
    const oneX = map['1 ve 0']
    const x2 = map['0 ve 2']
    if (m.hg > m.ag && playable(oneX) && oneX.od <= 1.45) {
      tips.push({
        kind: 'ÇŞ',
        pick: '1X',
        odds: oneX.od,
        priority: 73,
        text: 'Ev önde: 1X ile sonuç riski düşer (özellikle geç dakika).',
      })
    } else if (m.ag > m.hg && playable(x2) && x2.od <= 1.45) {
      tips.push({
        kind: 'ÇŞ',
        pick: 'X2',
        odds: x2.od,
        priority: 73,
        text: 'Dep önde: X2 güvenli iskelet.',
      })
    } else if (m.hg === m.ag && late) {
      const safer = [oneX, x2].filter(playable).sort((a, b) => a.od - b.od)[0]
      if (safer && safer.od <= 1.4) {
        tips.push({
          kind: 'ÇŞ',
          pick: safer === oneX ? '1X' : 'X2',
          odds: safer.od,
          priority: 70,
          text: 'Eşitlik + geç dakika: düşük oranlı çifte şans.',
        })
      }
    }
  }

  // ——— Alt/Üst: kalan süre + çizgi ———
  for (const ou of ous.slice(0, 4)) {
    const line = parseFloat((ou.n.match(/(\d+[.,]\d+)/) || [])[1]?.replace(',', '.'))
    if (!Number.isFinite(line)) continue
    const alt = (ou.o || []).find((o) => /^Alt$/i.test(o.n))
    const ust = (ou.o || []).find((o) => /^Üst$/i.test(o.n))
    const pair = alt && ust ? pairProbs(alt, ust) : null
    const need = Math.floor(line) + 1 - total // üst için gereken ek gol (2.5 → 3-total)

    if (total > line) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line} (geçti)`,
        odds: null,
        priority: 30,
        text: `Toplam ${total} > ${line}.`,
      })
      continue
    }

    // Geç dakika + gol ihtiyacı yüksek → Alt
    if (late && need >= 2 && playable(alt)) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 86,
        text: `${min}' · ${total}/${line}: üst için ≥${need} gol, kalan ~${rem}'. Alt baskın.`,
      })
    } else if (veryLate && need >= 1 && playable(alt) && (pair?.a ?? 0) >= 0.52) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 85,
        text: `${min}' çizgiye yakın (${total}/${line}): piyasa Alt ~%${Math.round((pair?.a || 0) * 100)}.`,
      })
    } else if (!late && need === 1 && playable(ust) && ust.od <= 2.1 && (pair?.b ?? 0) >= 0.45) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line}`,
        odds: ust.od,
        priority: 64,
        text: `Erken/orta: ${total}/${line}, tek gol yeter. Tempo + piyasa ile doğrula.`,
      })
    } else if (second && min >= 60 && total === Math.floor(line) && playable(alt) && alt.od <= 1.9) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 74,
        text: `Çizgiye yapışık; 60+ Alt ${line} sık tercih.`,
      })
    }
  }

  if (nextGoal && !dying) {
    const best = bestSide(nextGoal.o || [])
    // Geç tek taraflı maçta “sonraki gol = suskun” tuzağına düşme
    if (best && best.prob >= 0.48) {
      const silentName = m.hg > 0 && m.ag === 0 ? m.away : m.ag > 0 && m.hg === 0 ? m.home : null
      const tipsSilentNext = silentName && String(best.n).includes(silentName.slice(0, 6))
      if (veryLate && oneSided && tipsSilentNext && best.od > 2.2) {
        tips.push({
          kind: 'STRATEJİ',
          priority: 60,
          text: `${min}' sonraki golde suskun taraf pahalı (@${best.od.toFixed(2)}) — model zayıf; zorlama.`,
        })
      } else {
        tips.push({
          kind: 'SONRAKİ GOL',
          pick: best.n,
          odds: best.od,
          priority: 62,
          text: `Sonraki gol lean ~%${Math.round(best.prob * 100)}. Momentum / saha baskısı ile doğrula.`,
        })
      }
    }
  }

  if (first && min <= 15 && total === 0) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 58,
      text: "İlk 15' 0-0: erken pahalı favoriden kaçın; ilk gol sonrası oran kaymasını bekle.",
    })
  }

  if (veryLate && total >= 3) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 52,
      text: 'Açık maç + 80+: volatil; küçük birim veya izle.',
    })
  }

  const leagueCtx = peekLeagueContext(m.home, m.away, m.league)
  if (leagueCtx) {
    for (const t of tips) {
      const delta = liveTipDelta(t, leagueCtx)
      if (!delta) continue
      t.priority = (t.priority || 0) + delta
      if (leagueCtx.summary) t.text = `${t.text} Form: ${leagueCtx.summary}`
    }
  }

  tips.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return tips.filter((t, i, arr) => {
    if (t.odds != null && t.odds < 1.08) return false
    // Geç dakika tek taraflıda asla KG Var
    if (veryLate && oneSided && t.kind === 'KG' && /Var/i.test(t.pick || '') && !/oldu/i.test(t.pick || '')) {
      return false
    }
    // Önde iken asla MS X (85' 2-1 / @5.59 tuzağı)
    if ((m.hg || 0) !== (m.ag || 0) && t.kind === 'MS' && /MS X|^X$/i.test(t.pick || '')) {
      return false
    }
    if (t.odds >= 3.5 && t.kind === 'MS' && /Piyasa lean/i.test(t.text || '')) return false
    const key = `${t.kind}|${t.pick}|${t.text}`
    return arr.findIndex((x) => `${x.kind}|${x.pick}|${x.text}` === key) === i
  })
}

/** Basketbol saati futbol gibi “geçen dakika” değil: periyot + periyot içi kalan süre. */
function basketState(m) {
  const blob = `${m.period || ''} ${m.abbr || ''} ${m.periodLabel || ''}`
  const nba = /nba|wnba/i.test(`${m.league || ''} ${m.home || ''} ${m.away || ''}`)
  const qLen = nba ? 12 : 10
  const gameLen = nba ? 48 : 40
  const clock = Math.max(0, (Number(m.min) || 0) + (Number(m.sec) || 0) / 60)

  let quarter = 0
  let phase = 'live'
  if (/OVER|OT\b|UZAT/i.test(blob)) {
    quarter = 5
    phase = 'ot'
  } else if (/ARA|HALF_TIME|HALFTIME|\bHT\b|STOPPED/i.test(blob)) {
    quarter = 2
    phase = 'ht'
  } else if (/FOURTH|4\s*\.?\s*P/i.test(blob)) quarter = 4
  else if (/THIRD|3\s*\.?\s*P/i.test(blob)) quarter = 3
  else if (/SECOND|2\s*\.?\s*P/i.test(blob)) quarter = 2
  else if (/FIRST|1\s*\.?\s*P/i.test(blob)) quarter = 1

  let rem = null
  if (phase === 'ht') rem = 2 * qLen
  else if (phase === 'ot') rem = Math.max(clock, 0.25)
  else if (quarter >= 1 && quarter <= 4) rem = (4 - quarter) * qLen + clock

  const elapsed = rem == null ? null : Math.max(1, gameLen - rem)
  const scored = (m.hg || 0) + (m.ag || 0)
  const margin = (m.hg || 0) - (m.ag || 0)
  return {
    quarter,
    phase,
    qLen,
    gameLen,
    clock,
    rem,
    elapsed,
    pace: elapsed ? scored / elapsed : null,
    margin,
    abs: Math.abs(margin),
    scored,
    nba,
    leader: margin > 0 ? '1' : margin < 0 ? '2' : 'X',
    leaderName: margin >= 0 ? m.home : m.away,
  }
}

function twoWayLean(outcomes) {
  const all = (outcomes || []).filter((o) => typeof o.od === 'number' && o.od >= 1.01)
  if (all.length < 2) return null
  const probs = deVig(all)
  let i = 0
  for (let k = 1; k < probs.length; k++) if (probs[k] > probs[i]) i = k
  const pick = { ...all[i], prob: probs[i] }
  if (!playable(pick) || !oddsProbSane(pick.od, pick.prob)) return null
  const side = pick.n === '1' || pick.n === 1 ? '1' : pick.n === '2' || pick.n === 2 ? '2' : null
  return side ? { ...pick, side } : { ...pick, side: /Alt/i.test(pick.n) ? 'alt' : /Üst/i.test(pick.n) ? 'ust' : null }
}

function buildBasketTips(m, tips) {
  const markets = m.markets || []
  const st = basketState(m)
  const durum = tips.find((t) => t.kind === 'DURUM')
  if (durum) {
    const clock =
      st.phase === 'ht'
        ? 'devre arası'
        : st.phase === 'ot'
          ? `uzatma ${Math.floor(st.clock)}:${String(Math.round((st.clock % 1) * 60)).padStart(2, '0')}`
          : `${m.abbr || st.quarter + '.P'} kaldı ${Math.floor(st.clock)}:${String(Math.round((st.clock % 1) * 60)).padStart(2, '0')}`
    durum.text = `${clock} · ${m.home} ${m.score} ${m.away} · sayı ${st.scored} · fark ${st.abs}${
      st.rem != null ? ` · maça ~${Math.round(st.rem)} dk` : ''
    }${st.pace ? ` · tempo ${st.pace.toFixed(1)} sayı/dk` : ''}`
  }

  const ms = markets.find((x) => /^Maç Sonucu$/i.test(x.n))
  const totals = markets.filter(
    (x) => /Toplam Sayı Altı\/Üstü|^Altı\/Üstü/i.test(x.n) && !/Ev Sahibi|Deplasman|Çeyrek|Periyot|Handikap/i.test(x.n),
  )
  const handicaps = markets.filter((x) => /Handikap/i.test(x.n) && !/Çeyrek|Periyot|İlk Yarı/i.test(x.n))
  const periodMkts = markets.filter((x) => /Çeyrek|Periyot Sonucu|Yarı Sonucu/i.test(x.n))

  const lateQ =
    (st.quarter === 4 && st.clock <= 4) || (st.phase === 'ot' && st.clock <= 3)
  const veryLate = (st.quarter === 4 && st.clock <= 2) || (st.phase === 'ot' && st.clock <= 1.5)
  const homeOut = ms && (ms.o || []).find((o) => o.n === '1' || o.n === 1)
  const awayOut = ms && (ms.o || []).find((o) => o.n === '2' || o.n === 2)
  const leadOut = st.leader === '1' ? homeOut : st.leader === '2' ? awayOut : null

  // ——— MS: fark + kalan süre önce, piyasa sonra ———
  if (st.leader !== 'X' && st.abs >= 8 && (lateQ || (st.quarter >= 3 && st.abs >= 18) || (veryLate && st.abs >= 5))) {
    const conf =
      st.abs >= 16 && lateQ ? 0.9 : st.abs >= 10 && veryLate ? 0.84 : st.abs >= 18 ? 0.78 : 0.72
    const od = playable(leadOut) ? leadOut.od : null
    tips.push({
      kind: od != null ? 'MS' : 'STRATEJİ',
      pick: st.leader === '1' ? 'MS 1' : 'MS 2',
      odds: od,
      priority: 92,
      text: `${m.abbr || ''} ${m.score}: ${st.leaderName} +${st.abs}, periyotta ~${st.clock.toFixed(1)} dk. Sonuç prior'u lider (güven ~%${Math.round(conf * 100)}).`,
    })
  } else if (st.quarter === 4 && st.clock > 3 && st.abs <= 8) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 88,
      text: `4. periyot ${m.score}, fark ${st.abs}, süre var (~${st.clock.toFixed(1)} dk): MS kilitleme — geri dönüş penceresi. Handikap / toplam sayı.`,
    })
  } else if (st.phase === 'ht' && st.abs >= 12) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 70,
      text: `Devre ${m.score} (fark ${st.abs}): 2. yarı açılabilir. Lider eğilimi var, kilit MS değil.`,
    })
  } else if (st.phase === 'ht' && st.abs <= 6) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 72,
      text: `Devre sıkı (${m.score}): MS erken. Toplam sayı temposuna bak.`,
    })
  } else if (st.quarter > 0 && st.quarter <= 2 && st.abs <= 8) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 64,
      text: `Erken periyot sıkı maç (${m.score}). MS için 4. periyot farkını bekle.`,
    })
  }

  if (ms && st.leader !== 'X') {
    const fav = twoWayLean(ms.o || [])
    if (fav?.side && fav.prob >= 0.58 && fav.side === st.leader && (lateQ || st.abs >= 18)) {
      tips.push({
        kind: 'MS',
        pick: fav.side === '1' ? `MS 1 (${m.home})` : `MS 2 (${m.away})`,
        odds: fav.od,
        priority: 76,
        text: `Piyasa liderle uyumlu ~%${Math.round(fav.prob * 100)} (@${fav.od.toFixed(2)}). Fark ${st.abs}.`,
      })
    }
  }

  // ——— Toplam sayı: tempo × kalan süre ———
  for (const t of totals.slice(0, 3)) {
    const line = parseFloat((t.n.match(/(\d+[.,]\d+)/) || [])[1]?.replace(',', '.'))
    if (!Number.isFinite(line)) continue
    const alt = (t.o || []).find((o) => /^Alt$/i.test(o.n))
    const ust = (t.o || []).find((o) => /^Üst$/i.test(o.n))
    const needOver = Math.floor(line) + 1 - st.scored

    if (st.scored > line) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line} (geçti)`,
        odds: playable(ust) ? ust.od : null,
        priority: 40,
        text: `Toplam ${st.scored} > ${line}.`,
      })
      continue
    }

    const projected =
      st.pace && st.rem != null ? st.scored + st.pace * Math.min(st.rem, st.gameLen) : null

    if (lateQ && needOver >= 8 && playable(alt)) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 90,
        text: `${m.abbr || '4.P'} ${st.scored}/${line}: üste ${needOver} sayı, ~${st.clock.toFixed(1)} dk. Alt baskın.`,
      })
    } else if (veryLate && needOver >= 4 && playable(alt)) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 88,
        text: `Kapanış: ${st.scored}/${line}, üste ${needOver} sayı yetişmesi zor.`,
      })
    } else if (lateQ && needOver <= 2 && st.pace && st.pace * st.clock >= needOver && playable(ust)) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line}`,
        odds: ust.od,
        priority: 82,
        text: `Çizgiye yapışık (${st.scored}/${line}), tempo yetebilir.`,
      })
    } else if (projected != null && projected >= line + 10 && st.quarter > 0 && st.quarter <= 3 && playable(ust) && ust.od <= 1.9) {
      tips.push({
        kind: 'A/Ü',
        pick: `Üst ${line}`,
        odds: ust.od,
        priority: 74,
        text: `Tempo projeksiyon ~${projected.toFixed(0)} > ${line}. Erken/orta üst.`,
      })
    } else if (projected != null && projected <= line - 10 && st.elapsed > 8 && playable(alt) && alt.od <= 1.9) {
      tips.push({
        kind: 'A/Ü',
        pick: `Alt ${line}`,
        odds: alt.od,
        priority: 74,
        text: `Tempo projeksiyon ~${projected.toFixed(0)} < ${line}. Alt eğilimi.`,
      })
    }
  }

  // ——— Handikap: geç periyotta fark çizgiyi geçmişse ———
  for (const h of handicaps.slice(0, 2)) {
    const line = parseFloat((h.n.match(/(-?\d+[.,]\d+)/) || [])[1]?.replace(',', '.'))
    if (!Number.isFinite(line)) continue
    const coverBy = st.margin // home perspective; market naming varies
    if (lateQ && st.abs >= Math.abs(line) + 4) {
      tips.push({
        kind: 'HND',
        pick: `${st.leader === '1' ? 'Ev' : 'Dep'} handikap`,
        odds: null,
        priority: 68,
        text: `Fark ${st.abs} · ${h.n}. Geç periyotta lider farkı handikabı taşıyor; oranı kuponda doğrula.`,
      })
      break
    }
  }

  for (const p of periodMkts.slice(0, 1)) {
    const fav = twoWayLean(p.o || [])
    if (!fav || st.clock > 3) continue
    if (st.abs >= 6 && fav.side === st.leader) {
      tips.push({
        kind: 'PERİYOT',
        pick: fav.side === '1' ? `Periyot 1` : fav.side === '2' ? `Periyot 2` : fav.n,
        odds: fav.od,
        priority: 66,
        text: `Periyot içi fark ${st.abs}, süre ~${st.clock.toFixed(1)} dk. Kısa periyot sonucu.`,
      })
    }
  }

  if (st.phase === 'ot' && st.abs <= 3) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 80,
      text: `Uzatma sıkı (${m.score}): MS yüksek varyans, küçük birim.`,
    })
  }

  tips.sort((a, b) => (b.priority || 0) - (a.priority || 0))
  return tips.filter((t, i, arr) => {
    if (t.odds != null && t.odds < 1.08) return false
    if (t.odds >= 3.5 && t.kind === 'MS' && /Piyasa/i.test(t.text || '')) return false
    // Geç periyotta geride kalanı MS diye önerme
    if (lateQ && t.kind === 'MS' && st.leader === '1' && /MS 2/.test(t.pick || '')) return false
    if (lateQ && t.kind === 'MS' && st.leader === '2' && /MS 1/.test(t.pick || '')) return false
    const key = `${t.kind}|${t.pick}|${t.text}`
    return arr.findIndex((x) => `${x.kind}|${x.pick}|${x.text}` === key) === i
  })
}

export function rankLiveInterest(m) {
  if (m.sport === 'basketball' || m.sport === 'BB') {
    const blob = `${m.period || ''} ${m.abbr || ''}`
    let s = Math.min(20, Math.abs((m.hg || 0) - (m.ag || 0)) / 2)
    if (/4\.?\s*P|FOURTH|UZAT|OT/i.test(blob)) s += 10
    if (/3\.?\s*P|THIRD/i.test(blob)) s += 4
    if (m.markets?.some((x) => /Toplam Sayı|Maç Sonucu/i.test(x.n))) s += 3
    return s
  }
  let s = ((m.hg || 0) + (m.ag || 0)) * 2
  if ((m.min || 0) >= 70) s += 6
  if ((m.min || 0) >= 85) s += 3
  if (m.markets?.some((x) => /^Maç Sonucu$/i.test(x.n))) s += 3
  if (m.markets?.some((x) => /Altı\/Üstü/i.test(x.n))) s += 2
  if (m.sport === 'football' || m.sport === 'FB') s += 2
  return s
}
