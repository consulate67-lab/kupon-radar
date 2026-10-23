import { MARKET_WEIGHT, classifyMarket } from './misli.mjs'
import { leagueBias, leagueNote } from './intel/leagueForm.mjs'

const LEAGUE_BOOST = [
  [/uefa şampiyonlar|şampiyonlar ligi(?!.*u19)|champions league/i, 1.35],
  [/europa|uefa avrupa|konferans/i, 1.2],
  [/süper lig|super lig|türkiye/i, 1.3],
  [/premier lig|la liga|serie a|bundesliga|ligue 1/i, 1.3],
  [/nba|euroleague/i, 1.3],
  [/championship|ingiltere championship|1\. lig|2\. lig/i, 1.1],
  [/u19|u21|genç|youth|amist|hazırlık|friendly/i, 0.65],
]

function leagueTier(name = '') {
  for (const [re, w] of LEAGUE_BOOST) if (re.test(name)) return w
  return 0.95
}

function deVig(outcomes) {
  const inv = outcomes.map((o) => 1 / o.odds)
  const sum = inv.reduce((a, b) => a + b, 0)
  if (!sum) return outcomes.map(() => 0)
  return inv.map((x) => x / sum)
}

function overround(outcomes) {
  return outcomes.reduce((s, o) => s + 1 / o.odds, 0) - 1
}

function pickLabel(marketName, outcomeName, home, away) {
  const o = outcomeName
  if (o === '1') return `${marketName}: ${home}`
  if (o === '2') return `${marketName}: ${away}`
  if (o === 'X') return `${marketName}: Beraberlik`
  return `${marketName}: ${o}`
}

function analyzeMarket(market, match) {
  const kind = classifyMarket(market.name)
  const weight = MARKET_WEIGHT[kind] ?? 0.4
  if (weight < 0.5 && !['ou25', 'kg', 'ms', 'cs', 'ou', 'ah', 'iy'].includes(kind)) {
    // keep only core + a few useful; skip exotic noise for coupon engine
    if (!['ms_kg', 'ms_ou', 'iy_ms'].includes(kind)) return []
  }

  const outs = market.outcomes
  if (outs.length < 2) return []

  const probs = deVig(outs)
  const vig = overround(outs)
  const picks = []

  for (let i = 0; i < outs.length; i++) {
    const o = outs[i]
    const prob = probs[i]
    const fairOdds = prob > 0 ? 1 / prob : null
    const edge = fairOdds ? o.odds / fairOdds - 1 : 0 // vs de-vig fair — usually ~0; use relative ranking instead
    const playPct = match.playRatios?.[`${market.id}-${o.no}`] ?? 0

    // Ranking score inside market: prefer higher probability with still-usable odds
    let score =
      prob * 100 * weight * leagueTier(match.league) +
      playPct * 0.35 -
      Math.max(0, vig) * 25

    // Market-specific heuristics
    if (kind === 'ms') {
      if (prob >= 0.58) score += 10
      if (prob >= 0.68) score += 6
      if (o.name === 'X' && prob < 0.32) score -= 8
    }
    if (kind === 'cs') {
      // 1X / X2 are safer builds
      if ((o.name === '1X' || o.name === 'X2') && prob >= 0.7) score += 12
      if (o.name === '12' && prob >= 0.75) score += 4
    }
    if (kind === 'ou25' || kind === 'ou') {
      // Çizgi 2.5 diye otomatik puan yok. Net ayrışma varsa küçük artı.
      if (prob >= 0.64) score += 4
    }
    if (kind === 'kg') {
      if (prob >= 0.55) score += 7
    }
    if (kind === 'ah') {
      // Handicap draw (X) is rarely a good coupon leg
      if (o.name === 'X' || o.name === '0') continue
      const extreme = /[3-9]:0|0:[3-9]/.test(market.name)
      if (extreme) continue
      if (prob >= 0.55 && o.odds >= 1.4 && o.odds <= 2.4) score += 5
      else score -= 4
    }
    if (kind === 'iy') {
      if (prob >= 0.5) score += 3
    }

    // Odds drift: if shortened vs previous, market confidence
    if (o.prev && o.prev > o.odds) score += 3
    if (o.prev && o.prev < o.odds) score -= 1

    // Skip absurd longshots / ultra-low odds favorites for main coupon
    if (prob < 0.28 && !['kg', 'ou25', 'ou'].includes(kind)) continue
    if (o.odds > 4.5 && prob < 0.4) continue
    if (o.odds < 1.12) score -= 25
    if (o.odds < 1.2) score -= 10

    picks.push({
      marketId: market.id,
      marketName: market.name,
      marketKind: kind,
      outcomeNo: o.no,
      outcomeName: o.name,
      odds: o.odds,
      probability: prob,
      playPct,
      vig,
      score,
      label: pickLabel(market.name, o.name, match.home, match.away),
      shortPick: formatShortPick(market.name, o.name, kind),
    })
  }

  return picks
}

function formatShortPick(marketName, outcomeName, kind) {
  if (kind === 'ms') {
    if (outcomeName === '1') return 'MS 1'
    if (outcomeName === 'X') return 'MS X'
    if (outcomeName === '2') return 'MS 2'
  }
  if (kind === 'cs') return `ÇŞ ${outcomeName}`
  if (kind === 'kg') return `KG ${outcomeName}`
  if (kind === 'ou25' || kind === 'ou') {
    const line = marketName.match(/(\d+[.,]\d+)/)?.[1] || ''
    return `${outcomeName} ${line}`.trim()
  }
  if (kind === 'ah') return `${marketName.replace('Handikap ', 'Hnd ')} ${outcomeName}`
  if (kind === 'iy') return `İY ${outcomeName}`
  return `${marketName}: ${outcomeName}`.slice(0, 42)
}

function thinLeague(match) {
  const league = `${match.league || ''} ${match.home || ''} ${match.away || ''}`
  return /intermedia|amateur|regional|bölgesel|3\. lig|4\. lig|u19|u21|reserve|hazırlık|friendly|kadınlar|play-?off/i.test(
    league,
  )
}

/**
 * İkinci görüş: fiyat tek başına yetmez.
 * Ara lig + form yok + kısa Alt = fiyat var, maç kanıtı yok.
 */
function secondOpinion(pick, match, rivals) {
  const notes = []
  let delta = 0
  const opp = rivals.find((p) => p.marketId === pick.marketId && p.outcomeNo !== pick.outcomeNo)
  const gap = opp ? pick.probability - opp.probability : 0
  const under = /alt/i.test(`${pick.shortPick} ${pick.outcomeName}`)
  const over = /üst/i.test(`${pick.shortPick} ${pick.outcomeName}`)
  const ou = pick.marketKind === 'ou' || pick.marketKind === 'ou25'
  const obscure = thinLeague(match)
  const hasForm = !!match.leagueContext

  if (opp && gap < 0.08) {
    delta -= 12
    notes.push('Piyasa iki tarafa da yakın; net ayrışma yok')
  } else if (gap >= 0.16) {
    delta += 4
    notes.push(`Aynı markette ayrışma ~%${Math.round(gap * 100)}`)
  }

  const lowEvent =
    (ou && under) || (pick.marketKind === 'kg' && /yok/i.test(`${pick.shortPick} ${pick.outcomeName}`))
  if (lowEvent && obscure && !hasForm) {
    delta -= 22
    notes.push(
      'Ara lig, iç/dış form ve puan durumu yok. Kısa Alt / KG Yok fiyatı tek başına gerekçe değil; bu profilde 2-3 gol sık görülür',
    )
  } else if (ou && over && obscure && !hasForm && pick.probability < 0.58) {
    delta -= 8
    notes.push('Üst tarafı da kanıtsız; fiyat orta')
  }

  if (ou && hasForm) {
    notes.push('Gol çizgisi, takımların son maç ortalamasıyla birlikte okundu')
  }

  if (!hasForm && (pick.marketKind === 'ms' || pick.marketKind === 'cs') && pick.probability >= 0.6 && !obscure) {
    delta += 3
  }

  pick.notes = notes
  return delta
}

function commentary(match, pick) {
  const bits = []
  const pct = Math.round(pick.probability * 100)
  bits.push(`Piyasa ${pick.marketName} → ${pick.outcomeName} (~%${pct}, @${Number(pick.odds).toFixed(2)}).`)
  if (pick.notes?.length) bits.push(pick.notes.join('. ') + '.')
  const parked = (match.rejectedLeans || []).filter((r) => r.shortPick !== pick.shortPick).slice(0, 2)
  if (parked.length) {
    const list = parked.map((r) => `${r.shortPick} @${Number(r.odds).toFixed(2)}`).join(', ')
    bits.push(
      `Kısa fiyat olarak ${list} duruyor. Ara ligde iç/dış form, puan durumu ve son skorlar olmadığı için düşük-gol seçimini ana öneri yapmadım.`,
    )
  }
  if (pick.playPct) bits.push(`Oyuncu tercihi ~%${pick.playPct}.`)
  const form = leagueNote(match.leagueContext)
  if (form) bits.push(form)
  else if (thinLeague(match)) bits.push('Bu lig için puan durumu / iç-dış saha geçmişi bulunamadı; öneri temkinli.')
  if (match.live && match.kickoffMs && match.kickoffMs < Date.now()) bits.push('Maç canlı, oran kayabilir.')
  bits.push(`Lig: ${match.league}.`)
  return bits.join(' ')
}

export function analyzeMatch(match) {
  const markets = match.markets?.length ? match.markets : match.bulletinMarkets || []
  let candidates = []
  for (const market of markets) {
    candidates.push(...analyzeMarket(market, match))
  }
  if (match.leagueContext) {
    for (const c of candidates) c.score += leagueBias(c, match.leagueContext)
  }
  for (const c of candidates) c.score += secondOpinion(c, match, candidates)
  candidates.sort((a, b) => b.score - a.score)
  const unsupported = (p) => (p.notes || []).some((n) => n.includes('tek başına gerekçe değil'))
  const parked = candidates.filter(unsupported)
  const supported = candidates.filter((p) => !unsupported(p))
  if (parked.length && supported.length) {
    match.rejectedLeans = parked
    candidates = [...supported, ...parked]
  }

  // Diversify: keep best per market kind (top 2 for ou/ms)
  const best = []
  const kindCount = {}
  for (const c of candidates) {
    kindCount[c.marketKind] = (kindCount[c.marketKind] || 0) + 1
    const max = ['ou', 'ou25', 'ms'].includes(c.marketKind) ? 2 : 1
    if (kindCount[c.marketKind] <= max) best.push(c)
    if (best.length >= 8) break
  }

  const top = best[0] || candidates[0] || null
  if (!top) return null

  const kickMs = match.kickoffMs || Date.parse(match.kickoff)
  return {
    ...match,
    kickoffMs: kickMs,
    dateKey: istanbulDateKey(kickMs),
    kickoffLocal: new Date(kickMs).toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    }),
    pick: top,
    altPicks: best.slice(1, 5),
    analysis: commentary(match, top),
    score: top.score,
    leagueTier: leagueTier(match.league),
  }
}

export function istanbulDateKey(msOrDate) {
  const d = new Date(msOrDate)
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' }) // YYYY-MM-DD
}

export function shiftDateKey(dateKey, days) {
  const [y, m, d] = dateKey.split('-').map(Number)
  const utc = new Date(Date.UTC(y, m - 1, d))
  utc.setUTCDate(utc.getUTCDate() + days)
  return utc.toISOString().slice(0, 10)
}

function resolveDateRange({ dateMode = 'today', dateFrom, dateTo }) {
  const today = istanbulDateKey(Date.now())
  if (dateMode === 'all') return null
  if (dateMode === 'today') return { from: today, to: today }
  if (dateMode === 'tomorrow') {
    const tmr = shiftDateKey(today, 1)
    return { from: tmr, to: tmr }
  }
  if (dateMode === 'today_tomorrow') {
    return { from: today, to: shiftDateKey(today, 1) }
  }
  // custom / range
  const from = dateFrom || today
  const to = dateTo || dateFrom || today
  return { from: from <= to ? from : to, to: from <= to ? to : from }
}

export function isUpcomingKickoff(match, now = Date.now()) {
  // Misli, kickoff'u gelmemiş gece maçlarını da LIVE diye işaretler.
  // Havuz kararı saate göre: başlamamışsa kupona girebilir.
  const kick = Number(match.kickoffMs || Date.parse(match.kickoff) || 0)
  return kick > now
}

function productOf(legs) {
  return legs.reduce((p, m) => p * (m.pick?.odds || 1), 1)
}

function applyPick(match, pick) {
  if (!pick) return match
  return {
    ...match,
    pick,
    analysis: commentary(match, pick),
    score: pick.score ?? match.score,
  }
}

function allPicks(match) {
  const list = []
  if (match?.pick) list.push(match.pick)
  for (const p of match?.altPicks || []) {
    if (p && !list.some((x) => x.shortPick === p.shortPick && x.odds === p.odds)) list.push(p)
  }
  return list
}

/** Maç için hedef orana en yakın seçim (min oran altı yok). Üst sınır yoksa en yükseğe kaçmaz. */
function withTargetPick(match, minOdds, targetOdds = null) {
  const cands = allPicks(match).filter((p) => p.odds >= minOdds && p.odds <= 8)
  if (!cands.length) return null
  const t = targetOdds && targetOdds > 0 ? Math.max(targetOdds, minOdds) : minOdds
  const pick = [...cands].sort((a, b) => {
    const da = Math.abs(Math.log(a.odds / t))
    const db = Math.abs(Math.log(b.odds / t))
    if (Math.abs(da - db) > 0.015) return da - db
    return (b.score || 0) - (a.score || 0)
  })[0]
  return applyPick(match, pick)
}

function highestOddsVariant(match, minOdds) {
  const cands = allPicks(match).filter((p) => p.odds >= minOdds)
  if (!cands.length) return null
  const pick = [...cands].sort((a, b) => b.odds - a.odds)[0]
  return applyPick(match, pick)
}

function boostToMinTotal(selected, pool, minTotalOdds, minOdds, maxLegs = 10) {
  if (!selected.length) return { selected, met: false }
  if (!minTotalOdds || minTotalOdds <= 1 || productOf(selected) >= minTotalOdds) {
    return { selected, met: productOf(selected) >= (minTotalOdds || 0) || minTotalOdds <= 1 }
  }

  const used = new Set(selected.map((s) => s.eventId))
  let legs = selected.map((m) => ({ ...m }))

  // 1) Her bacağı hedefe göre yükselt (önce yeten en düşük, yoksa en yüksek alt)
  for (let i = 0; i < legs.length && productOf(legs) < minTotalOdds; i++) {
    const need = minTotalOdds / (productOf(legs) / legs[i].pick.odds)
    const raised = withTargetPick(legs[i], minOdds, need)
    if (raised && raised.pick.odds > legs[i].pick.odds) legs[i] = raised
  }

  // 2) Hâlâ düşükse tüm bacakları mümkün olan en yüksek orana çek
  if (productOf(legs) < minTotalOdds) {
    legs = legs.map((m) => highestOddsVariant(m, minOdds) || m)
  }

  // 3) Zayıf bacağı havuzdan daha yüksek oranlı maçla değiştir
  for (let round = 0; round < 40 && productOf(legs) < minTotalOdds; round++) {
    const idx = legs.reduce((best, m, i) => (m.pick.odds < legs[best].pick.odds ? i : best), 0)
    const weak = legs[idx]
    const need = minTotalOdds / (productOf(legs) / weak.pick.odds)
    const teams = new Set(legs.filter((_, i) => i !== idx).flatMap((s) => [s.home, s.away]))

    const candidate = pool
      .filter((m) => m.eventId !== weak.eventId && (!used.has(m.eventId) || m.eventId === weak.eventId))
      .filter((m) => !teams.has(m.home) && !teams.has(m.away))
      .map((m) => withTargetPick(m, minOdds, need) || highestOddsVariant(m, minOdds))
      .filter((m) => m && m.pick.odds > weak.pick.odds)
      .sort((a, b) => {
        const aFit = a.pick.odds >= need ? 0 : 1
        const bFit = b.pick.odds >= need ? 0 : 1
        if (aFit !== bFit) return aFit - bFit
        return b.pick.odds - a.pick.odds || b.score - a.score
      })[0]

    if (!candidate) break
    used.delete(weak.eventId)
    used.add(candidate.eventId)
    legs[idx] = candidate
  }

  // 4) Hâlâ yetmiyorsa ekstra maç ekle (toplam oran öncelikli)
  while (productOf(legs) < minTotalOdds && legs.length < maxLegs) {
    const teams = new Set(legs.flatMap((s) => [s.home, s.away]))
    const need = minTotalOdds / productOf(legs)
    const extra = pool
      .filter((m) => !used.has(m.eventId))
      .filter((m) => !teams.has(m.home) && !teams.has(m.away))
      .map((m) => withTargetPick(m, minOdds, need) || highestOddsVariant(m, minOdds))
      .filter(Boolean)
      .sort((a, b) => {
        const aFit = a.pick.odds >= need ? 0 : 1
        const bFit = b.pick.odds >= need ? 0 : 1
        if (aFit !== bFit) return aFit - bFit
        return b.pick.odds - a.pick.odds || b.score - a.score
      })[0]
    if (!extra) break
    used.add(extra.eventId)
    legs.push(extra)
  }

  return { selected: legs, met: productOf(legs) >= minTotalOdds }
}

/** Toplam oranı hedefin etrafında tut. Min oran × maç sayısı hedefi aşıyorsa bacak düşer. */
function shapeToTotal(selected, pool, minTotal, minOdds) {
  if (!selected.length) return { selected, met: false, trimmed: false }
  const ceiling = Math.max(minTotal * 1.35, minTotal + 0.6)
  const aimFor = (count) => Math.max(minOdds, Math.pow(Math.max(minTotal, 1.01), 1 / count))
  let legs = selected.map((m) => withTargetPick(m, minOdds, aimFor(selected.length)) || m)
  let trimmed = false

  while (legs.length > 1 && Math.pow(minOdds, legs.length) > ceiling + 1e-6) {
    legs.pop()
    trimmed = true
  }

  for (let round = 0; round < 10; round++) {
    const prod = productOf(legs)
    if (prod >= minTotal * 0.92 && prod <= ceiling) break
    legs = legs.map((m) => withTargetPick(m, minOdds, aimFor(legs.length)) || m)
    if (productOf(legs) > ceiling && legs.length > 1) {
      const idx = legs.reduce((best, m, i) => (m.pick.odds > legs[best].pick.odds ? i : best), 0)
      legs.splice(idx, 1)
      trimmed = true
      continue
    }
    if (productOf(legs) < minTotal * 0.92) {
      const used = new Set(legs.map((l) => l.eventId))
      const aim = aimFor(legs.length)
      const idx = legs.reduce((best, m, i) => (m.pick.odds < legs[best].pick.odds ? i : best), 0)
      const swap = pool
        .filter((m) => !used.has(m.eventId))
        .map((m) => withTargetPick(m, minOdds, aim))
        .filter((m) => m && m.pick.odds >= legs[idx].pick.odds)
        .sort((a, b) => Math.abs(Math.log(a.pick.odds / aim)) - Math.abs(Math.log(b.pick.odds / aim)))[0]
      if (!swap) break
      const next = legs.slice()
      next[idx] = swap
      if (productOf(next) > ceiling * 1.15) break
      legs = next
    }
  }

  const prod = productOf(legs)
  return {
    selected: legs,
    met: prod >= minTotal * 0.92 && prod <= ceiling,
    trimmed,
    ceiling,
  }
}

export function buildCoupon(
  analyzed,
  {
    matchCount = 4,
    minOdds = 1.3,
    minTotalOdds = 1,
    sports = 'all',
    marketFocus = 'all',
    dateMode = 'all',
    dateFrom,
    dateTo,
  },
) {
  const now = Date.now()
  const minTotal = Math.max(1, Number(minTotalOdds) || 1)
  const n = Math.min(10, Math.max(1, Number(matchCount) || 4))
  // Geometrik hedef: n maçla toplam ≥ minTotal için maç başı ~g
  const geoTarget = minTotal > 1 ? Math.max(minOdds, Math.pow(minTotal, 1 / n)) : minOdds

  // Tarih filtresi yok — sadece henüz başlamamış + maç başı min oran
  let pool = analyzed
    .filter((m) => m?.pick && isUpcomingKickoff(m, now))
    .map((m) => withTargetPick(m, minOdds, geoTarget) || highestOddsVariant(m, minOdds))
    .filter(Boolean)

  // dateMode açıkça verilirse (geri uyumluluk); varsayılan all = filtre yok
  const range =
    dateMode && dateMode !== 'all' ? resolveDateRange({ dateMode, dateFrom, dateTo }) : null
  if (range) {
    pool = pool.filter((m) => {
      const key = m.dateKey || istanbulDateKey(m.kickoffMs || m.kickoff)
      return key >= range.from && key <= range.to
    })
  }

  if (sports === 'football') pool = pool.filter((m) => m.sport === 'football')
  if (sports === 'basketball') pool = pool.filter((m) => m.sport === 'basketball')

  if (marketFocus !== 'all') {
    const map = {
      ms: ['ms'],
      goals: ['ou', 'ou25', 'kg', 'ms_ou', 'ms_kg'],
      safe: ['cs', 'ms'],
      handicap: ['ah'],
    }
    const allow = map[marketFocus]
    if (allow) {
      const preferred = pool
        .map((m) => {
          if (allow.includes(m.pick.marketKind)) return m
          const alt = allPicks(m).find((p) => allow.includes(p.marketKind) && p.odds >= minOdds)
          if (!alt) return null
          return applyPick(m, alt)
        })
        .filter(Boolean)
      if (preferred.length >= n) pool = preferred
      else pool = [...preferred, ...pool.filter((m) => !preferred.some((p) => p.eventId === m.eventId))]
    }
  }

  // Hedef orana yakınlık önce — yüksek skor tek başına 5+ oranı seçmesin
  pool.sort((a, b) => {
    const aNear = Math.abs(Math.log(a.pick.odds / geoTarget))
    const bNear = Math.abs(Math.log(b.pick.odds / geoTarget))
    if (Math.abs(aNear - bNear) > 0.08) return aNear - bNear
    return b.score - a.score
  })

  const selected = []
  const kindUsed = {}

  for (const m of pool) {
    if (selected.length >= n) break
    if (selected.some((s) => s.eventId === m.eventId)) continue
    const teams = new Set(selected.flatMap((s) => [s.home, s.away]))
    if (teams.has(m.home) || teams.has(m.away)) continue

    const k = m.pick.marketKind
    if ((kindUsed[k] || 0) >= 2 && selected.length < n - 1) continue

    selected.push(m)
    kindUsed[k] = (kindUsed[k] || 0) + 1
  }

  for (const m of pool) {
    if (selected.length >= n) break
    if (selected.some((s) => s.eventId === m.eventId)) continue
    selected.push(m)
  }

  const shaped = shapeToTotal(selected, pool, minTotal, minOdds)
  const finalLegs = shaped.selected
  const totalOdds = Number(productOf(finalLegs).toFixed(2))

  const avgProb = finalLegs.reduce((s, m) => s + m.pick.probability, 0) / (finalLegs.length || 1)
  const confidence = Math.round(
    Math.min(96, avgProb * 88 + finalLegs.reduce((s, m) => s + (m.leagueTier || 1), 0) * 1.5),
  )

  let note = `Maç başı ≥${minOdds} · toplam hedef ${minTotal} · sonuç ${totalOdds}.`
  if (!finalLegs.length) {
    note = `Maç başı ≥${minOdds} için yaklaşan maç yok.`
  } else if (shaped.trimmed) {
    note = `${n} maç × min ${minOdds} hedef ${minTotal} oranını aşıyordu. ${finalLegs.length} seçim · toplam ${totalOdds} (tavan ~${shaped.ceiling.toFixed(2)}).`
  } else if (!shaped.met && totalOdds > shaped.ceiling) {
    note = `Toplam ${totalOdds} — hedef ${minTotal} için daha kısa oran bulunamadı (maç başı ≥${minOdds}).`
  } else if (!shaped.met && minTotal > 1) {
    note = `Toplam ${totalOdds} — hedef ${minTotal} tutturulamadı (maç başı ≥${minOdds} korundu).`
  } else if (finalLegs.length < n) {
    note = `${finalLegs.length} seçim · toplam ${totalOdds} (hedef ${minTotal}).`
  } else {
    note += ' Bilgi amaçlıdır.'
  }

  return {
    legs: finalLegs.map((m, i) => ({
      order: i + 1,
      eventId: m.eventId,
      sport: m.sport,
      league: m.league,
      home: m.home,
      away: m.away,
      kickoff: m.kickoffLocal || m.kickoff,
      dateKey: m.dateKey || istanbulDateKey(m.kickoffMs || m.kickoff),
      pick: m.pick.shortPick,
      market: m.pick.marketName,
      outcome: m.pick.outcomeName,
      team: m.pick.outcomeName === '1' ? m.home : m.pick.outcomeName === '2' ? m.away : m.pick.outcomeName,
      odds: Number(m.pick.odds.toFixed(2)),
      probability: Math.round(m.pick.probability * 100),
      playPct: m.pick.playPct || 0,
      marketKind: m.pick.marketKind,
      analysis: m.analysis,
      score: Number((m.score || 0).toFixed(1)),
      altPicks: (m.altPicks || []).slice(0, 3).map((p) => ({
        pick: p.shortPick,
        odds: Number(p.odds.toFixed(2)),
        probability: Math.round(p.probability * 100),
      })),
      misliUrl: `https://www.misli.com/iddaa/${m.eventId}`,
    })),
    totalOdds,
    matchCount: finalLegs.length,
    requestedMatchCount: n,
    minOdds,
    minTotalOdds: minTotal,
    totalTargetMet: shaped.met || minTotal <= 1,
    confidence,
    dateFilter: null,
    dateLabel: null,
    note,
  }
}

export function preliminaryRank(match) {
  // Rank from bulletin markets before full fetch
  const markets = match.bulletinMarkets || []
  let best = 0
  for (const market of markets) {
    const kind = classifyMarket(market.name)
    const w = MARKET_WEIGHT[kind] || 0.4
    if (!market.outcomes.length) continue
    const probs = deVig(market.outcomes)
    for (let i = 0; i < market.outcomes.length; i++) {
      const odds = market.outcomes[i].odds
      const prob = probs[i]
      if (odds < 1.2 || odds > 3.2) continue
      let s = prob * 100 * w * leagueTier(match.league)
      if (odds >= 1.3 && odds <= 2.1) s += 8
      if (['ou25', 'kg', 'cs'].includes(kind)) s += 3
      if (s > best) best = s
    }
  }
  return best
}
