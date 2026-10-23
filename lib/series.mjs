/**
 * Seri katlama planı — düşük riskli 1–3’lü adımlar, gün/saat takvimi,
 * riski paralel kuponlara bölme. “Kesin” değildir; bankroll yönetimi.
 */

import { isYouthMatch } from './intel/brain.mjs'

function product(oddsList) {
  return oddsList.reduce((p, o) => p * o, 1)
}

function istanbulParts(ms) {
  const d = new Date(ms)
  const dateKey = d.toLocaleDateString('en-CA', { timeZone: 'Europe/Istanbul' })
  const time = d.toLocaleTimeString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    hour: '2-digit',
    minute: '2-digit',
  })
  const dayLabel = d.toLocaleDateString('tr-TR', {
    timeZone: 'Europe/Istanbul',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  })
  return { dateKey, time, dayLabel }
}

function allPicks(m) {
  const list = []
  if (m?.pick) list.push(m.pick)
  for (const p of m?.altPicks || []) {
    if (p && !list.some((x) => x.shortPick === p.shortPick && Math.abs(x.odds - p.odds) < 0.001)) {
      list.push(p)
    }
  }
  return list
}

/** Düşük risk skoru — yüksek = daha güvenli tercih */
function safeScore(pick, match) {
  let s = (pick.probability || 0) * 100
  s += (match.leagueTier || 1) * 8
  if (['cs', 'ms'].includes(pick.marketKind)) s += 12
  if (pick.marketKind === 'ou25' || pick.marketKind === 'ou') {
    if (/Alt/i.test(pick.shortPick || '')) s += 10
    else s -= 18 // Üst seri katlamada volatil
  }
  if (pick.marketKind === 'kg') {
    if (/Yok/i.test(pick.shortPick || '')) s += 8
    else s -= 22 // KG Var seri için elenir
  }
  if (pick.odds >= 1.18 && pick.odds <= 1.45) s += 14
  else if (pick.odds <= 1.55) s += 8
  else if (pick.odds > 1.7) s -= 20
  if (pick.probability >= 0.62) s += 10
  if (pick.probability >= 0.7) s += 8
  if (pick.probability < 0.52) s -= 25
  if (isYouthMatch(match)) s -= 40
  if (/U19|U21|Hazırlık|Friendly|Amateur/i.test(match.league || '')) s -= 15
  return s
}

function toLeg(match, pick) {
  const kick = Number(match.kickoffMs || Date.parse(match.kickoff) || 0)
  const { dateKey, time, dayLabel } = istanbulParts(kick)
  return {
    eventId: match.eventId,
    sport: match.sport,
    league: match.league,
    home: match.home,
    away: match.away,
    kickoffMs: kick,
    kickoffLocal: match.kickoffLocal || `${dayLabel} ${time}`,
    dateKey,
    time,
    dayLabel,
    pick: pick.shortPick,
    market: pick.marketName,
    marketKind: pick.marketKind,
    odds: Number(pick.odds.toFixed(2)),
    probability: Math.round((pick.probability || 0) * 100),
    safeScore: Number(safeScore(pick, match).toFixed(1)),
    analysis: match.analysis,
    misliUrl: `https://www.misli.com/iddaa/${match.eventId}`,
  }
}

/**
 * Havuzdan güvenli aday bacaklar (tek seçim / maç).
 */
function buildSafePool(analyzed, { sports = 'all', minProb = 0.55, maxLegOdds = 1.65, minLegOdds = 1.15 } = {}) {
  const now = Date.now()
  const pool = []

  for (const m of analyzed || []) {
    if (!m?.pick) continue
    const kick = Number(m.kickoffMs || Date.parse(m.kickoff) || 0)
    if (!kick || kick <= now) continue
    if (sports === 'football' && m.sport !== 'football') continue
    if (sports === 'basketball' && m.sport !== 'basketball') continue
    if (isYouthMatch(m)) continue

    const cands = allPicks(m)
      .filter((p) => p.odds >= minLegOdds && p.odds <= maxLegOdds)
      .filter((p) => (p.probability || 0) >= minProb)
      .filter((p) => ['ms', 'cs', 'ou25', 'ou', 'kg'].includes(p.marketKind))
      .filter((p) => !(p.marketKind === 'kg' && /Var/i.test(p.shortPick || '')))
      .filter((p) => !((p.marketKind === 'ou25' || p.marketKind === 'ou') && /Üst/i.test(p.shortPick || '')))
      .map((p) => ({ match: m, pick: p, score: safeScore(p, m) }))
      .sort((a, b) => b.score - a.score)

    if (!cands.length) continue
    const best = cands[0]
    if (best.score < 55) continue
    pool.push({ ...best, kick })
  }

  pool.sort((a, b) => a.kick - b.kick || b.score - a.score)
  return pool
}

/**
 * Hedef orana yakın 1–3 bacak paketi (kronolojik komşu maçlar).
 */
function packRound(candidates, usedIds, targetOdds, maxLegs = 3) {
  const avail = candidates.filter((c) => !usedIds.has(c.match.eventId))
  if (!avail.length) return null

  const start = avail[0]
  const windowMs = 6 * 60 * 60 * 1000 // aynı “oturum” ~6 saat
  const window = avail.filter((c) => c.kick - start.kick <= windowMs)

  // Tek maç yeterli mi?
  const single = window
    .filter((c) => c.pick.odds >= targetOdds * 0.92 && c.pick.odds <= targetOdds * 1.25)
    .sort((a, b) => b.score - a.score)[0]
  if (single && single.pick.probability >= 0.62) {
    return [single]
  }

  // 2–3’lü: düşük oranlı güvenli bacaklarla çarpım ~ hedef
  const ranked = [...window].sort((a, b) => b.score - a.score)
  let best = null
  let bestDiff = Infinity

  for (let n = 2; n <= Math.min(maxLegs, ranked.length); n++) {
    // greedy: en güvenli n, gerekirse oran için swap
    const pick = []
    const seen = new Set()
    for (const c of ranked) {
      if (pick.length >= n) break
      if (seen.has(c.match.eventId)) continue
      const teams = new Set(pick.flatMap((x) => [x.match.home, x.match.away]))
      if (teams.has(c.match.home) || teams.has(c.match.away)) continue
      pick.push(c)
      seen.add(c.match.eventId)
    }
    if (pick.length < n) continue

    let odds = product(pick.map((x) => x.pick.odds))
    // hedefe yaklaştır: en düşük skorlu bacağı daha yüksek oranlı güvenli ile değiştir
    for (let round = 0; round < 8 && odds < targetOdds * 0.92; round++) {
      const weakI = pick.reduce((bi, x, i) => (x.score < pick[bi].score ? i : bi), 0)
      const need = targetOdds / (odds / pick[weakI].pick.odds)
      const repl = ranked.find(
        (c) =>
          !seen.has(c.match.eventId) &&
          c.pick.odds >= Math.min(need, 1.55) &&
          c.pick.odds <= 1.7 &&
          c.score >= 58,
      )
      if (!repl) break
      seen.delete(pick[weakI].match.eventId)
      seen.add(repl.match.eventId)
      pick[weakI] = repl
      odds = product(pick.map((x) => x.pick.odds))
    }

    const diff = Math.abs(odds - targetOdds)
    const minProb = Math.min(...pick.map((x) => x.pick.probability || 0))
    if (minProb < 0.54) continue
    if (odds >= targetOdds * 0.85 && odds <= targetOdds * 1.45 && diff < bestDiff) {
      best = pick
      bestDiff = diff
    }
  }

  // tek güvenli düşük oran — hedef altı ama oynanabilir (oran değişir uyarısı)
  if (!best && single) return [single]
  if (!best && ranked[0] && ranked[0].pick.probability >= 0.68 && ranked[0].pick.odds <= 1.4) {
    return [ranked[0]]
  }
  return best
}

function formatCouponText(step, branch, stake) {
  const legs = branch.legs
  const lines = [
    `SERİ #${step} · Kupon ${branch.label} · Misli ${stake} TL`,
    `${legs.length} seçim · Oran ${branch.totalOdds.toFixed(2)} · Tahmini dönüş ${(stake * branch.totalOdds).toFixed(2)} TL`,
    `${branch.windowLabel}`,
    '',
    ...legs.map(
      (l, i) =>
        `${i + 1}) ${l.dayLabel} ${l.time} · ${l.home} vs ${l.away}\n   ${l.pick} | ${l.market} @${l.odds}\n   ${l.misliUrl}`,
    ),
  ]
  return lines.join('\n')
}

/**
 * @param {object[]} analyzed analyzeMatch çıktıları
 */
export function buildSeriesPlan(
  analyzed,
  {
    startBank = 50,
    unitStake = 50,
    parallel = 2,
    rounds = 6,
    targetOdds = 2.05,
    sports = 'all',
  } = {},
) {
  const pool = buildSafePool(analyzed, { sports })
  const used = new Set()
  const steps = []
  let bank = Number(startBank) || 50
  const unit = Number(unitStake) || 50
  const par = Math.min(3, Math.max(1, Number(parallel) || 2))
  const target = Math.max(1.6, Math.min(3.2, Number(targetOdds) || 2.05))
  const maxRounds = Math.min(12, Math.max(1, Number(rounds) || 6))

  for (let step = 1; step <= maxRounds; step++) {
    // Bankaya göre kaç paralel kupon
    const canParallel = bank >= unit * par ? par : bank >= unit * 2 ? 2 : 1
    const stakeEach = Math.max(1, Math.floor((bank / canParallel) * 100) / 100)
    // Kullanıcı modeli: birim 50 civarı kalsın
    const stake = Math.min(stakeEach, Math.max(unit, Math.floor(bank / canParallel)))

    const branches = []
    for (let b = 0; b < canParallel; b++) {
      const packed = packRound(pool, used, target, 3)
      if (!packed?.length) break
      for (const c of packed) used.add(c.match.eventId)

      const legs = packed.map((c) => toLeg(c.match, c.pick)).sort((a, b) => a.kickoffMs - b.kickoffMs)
      const totalOdds = Number(product(legs.map((l) => l.odds)).toFixed(2))
      const first = legs[0]
      const last = legs[legs.length - 1]
      const windowLabel =
        first.dateKey === last.dateKey
          ? `${first.dayLabel} · ${first.time}${legs.length > 1 ? `–${last.time}` : ''}`
          : `${first.dayLabel} ${first.time} → ${last.dayLabel} ${last.time}`

      const branch = {
        label: String.fromCharCode(65 + b), // A, B
        legs,
        totalOdds,
        targetOdds: target,
        targetMet: totalOdds >= target * 0.9,
        estReturn: Number((stake * totalOdds).toFixed(2)),
        windowLabel,
        riskNote:
          totalOdds < target * 0.9
            ? 'Oran hedef katın altında — maç günü oran kayabilir; yine de düşük riskli paket.'
            : totalOdds > target * 1.25
              ? 'Oran hedefin üstünde: biraz daha volatil, bacak sayısı/seçim kontrol et.'
              : 'Hedef kata yakın paket.',
      }
      branch.copyText = formatCouponText(step, branch, stake)
      branches.push(branch)
    }

    if (!branches.length) break

    // Her kupon stake×oran; ikisi tutarsa toplam, biri tutarsa min dönüş
    const bothWin = Number(branches.reduce((s, br) => s + stake * br.totalOdds, 0).toFixed(2))
    const oneWin = Number((stake * Math.min(...branches.map((br) => br.totalOdds))).toFixed(2))

    const schedule = branches.flatMap((br) =>
      br.legs.map((l) => ({
        step,
        branch: br.label,
        dateKey: l.dateKey,
        dayLabel: l.dayLabel,
        time: l.time,
        match: `${l.home} vs ${l.away}`,
        pick: l.pick,
        odds: l.odds,
      })),
    )

    steps.push({
      step,
      bankBefore: Number(bank.toFixed(2)),
      parallel: canParallel,
      stakeEach: stake,
      stakeTotal: Number((stake * canParallel).toFixed(2)),
      coupons: branches,
      schedule,
      projection: {
        ifOneWins: oneWin,
        ifAllWin: bothWin,
        nextBankIfAllWin: bothWin,
        nextBankIfOneWins: oneWin,
      },
      note:
        canParallel > 1
          ? `${canParallel} paralel kupon × ${stake} TL — biri düşerse diğeri bankayı taşır; ikisi tutarsa ~${bothWin} TL.`
          : `Tek kupon ${stake} TL (banka ${bank.toFixed(0)} TL henüz ${par}’ye bölünemez). Tutarsa ~${bothWin} TL.`,
    })

    // Bir sonraki adım için bankayı “hepsi tuttu” senaryosuyla ilerlet (plan)
    bank = bothWin > 0 ? bothWin : bank * target
  }

  const calendar = []
  const byDay = new Map()
  for (const st of steps) {
    for (const row of st.schedule) {
      if (!byDay.has(row.dateKey)) byDay.set(row.dateKey, [])
      byDay.get(row.dateKey).push(row)
    }
  }
  for (const [dateKey, rows] of [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    rows.sort((a, b) => a.time.localeCompare(b.time))
    calendar.push({
      dateKey,
      dayLabel: rows[0].dayLabel,
      plays: rows,
    })
  }

  return {
    startBank: Number(startBank),
    unitStake: unit,
    parallel: par,
    targetOdds: target,
    roundsPlanned: steps.length,
    poolSize: pool.length,
    steps,
    calendar,
    disclaimer:
      'Bilgi / bankroll planı — garanti değildir. Oranlar maç gününe kadar değişir; öneri güncellenir. 18+ sorumlu oyun. Gençlik (U21) bilinçli elendi.',
    howTo:
      'Her adımda A/B kuponlarını o günkü saatte oyna. Tutarsa bir sonraki adıma geç. Biri düşerse diğer kuponun dönüşüyle birimi koru; sıfırdan startBank ile yeniden başla.',
  }
}
