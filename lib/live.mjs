import { fetchBulletin, fetchCompetitionMap } from './misli.mjs'
import { buildLiveTips, rankLiveInterest } from './liveTips.mjs'

function scoreOf(sc, side) {
  if (!sc) return { goals: 0, red: 0 }
  const block = side === 'home' ? sc.ht : sc.at
  return {
    goals: Number(block?.r ?? block?.c ?? 0) || 0,
    red: Number(block?.rc ?? 0) || 0,
    htGoals: Number(block?.ht ?? 0) || 0,
  }
}

function normalizeMarkets(rawMarkets = []) {
  return rawMarkets.map((m) => ({
    n: m.n,
    o: (m.o || [])
      .filter((x) => typeof x.od === 'number')
      .map((x) => ({ n: x.n, od: x.od })),
  }))
}

export function normalizeLiveEvent(raw, league = 'Diğer') {
  const home = raw.p?.[0]?.n || raw.ph || raw.n?.split(' - ')[0] || '?'
  const away = raw.p?.[1]?.n || raw.pa || raw.n?.split(' - ')[1] || '?'
  const sc = raw.sc || null
  const homeS = scoreOf(sc, 'home')
  const awayS = scoreOf(sc, 'away')
  const sport = raw.st === 'BASKETBALL' ? 'basketball' : 'football'
  const base = {
    eventId: raw.i,
    sport,
    league: league || 'Diğer',
    home,
    away,
    kickoffMs: raw.d,
    live: !!raw.l,
    minute: sc?.min ?? raw.t ?? null,
    min: sc?.min ?? raw.t ?? null,
    sec: Number(sc?.sec ?? 0) || 0,
    period: sc?.s || null,
    periodLabel: sc?.abbr || (raw.l ? 'CANLI' : ''),
    abbr: sc?.abbr || '',
    score: `${homeS.goals}-${awayS.goals}`,
    homeGoals: homeS.goals,
    awayGoals: awayS.goals,
    hg: homeS.goals,
    ag: awayS.goals,
    homeRed: homeS.red,
    awayRed: awayS.red,
    status: raw.s,
    markets: normalizeMarkets(raw.m || []),
    misliUrl: `https://www.misli.com/iddaa/${raw.i}`,
  }
  base.tips = buildLiveTips(base)
  base.interest = rankLiveInterest(base)
  return base
}

function parseLiveBulletin(data, sport, compMap) {
  // reuse league map logic from parseBulletin headers
  const events = data?.e || []
  let headerLeague = null
  const out = []
  for (const e of events) {
    if (!e.m || !e.m.length) {
      if (e.p?.[0]?.n) headerLeague = e.p[0].n
      else if (e.n) headerLeague = e.n.split(' - ')[0]
      continue
    }
    const clock = `${e.sc?.abbr || ''} ${e.sc?.s || ''}`
    if (/SCHEDULED|NOT_STARTED|NS\b/i.test(clock)) continue
    if (!e.l && !e.sc) continue
    const league = (e.cp && compMap.get(Number(e.cp))) || headerLeague || 'Diğer'
    out.push(normalizeLiveEvent(e, league))
  }
  // also include events that have sc even if briefly without markets
  for (const e of events) {
    if (!e.sc || out.some((x) => x.eventId === e.i)) continue
    if (e.m?.length) continue
    const league = (e.cp && compMap.get(Number(e.cp))) || headerLeague || 'Diğer'
    if (e.l) out.push(normalizeLiveEvent({ ...e, p: e.p, n: e.n }, league))
  }
  return out
}

function diffAlerts(prev, next) {
  const alerts = []
  const prevMap = new Map((prev || []).map((m) => [m.eventId, m]))
  const now = Date.now()

  for (const m of next) {
    const p = prevMap.get(m.eventId)
    const base = {
      eventId: m.eventId,
      home: m.home,
      away: m.away,
      league: m.league,
      sport: m.sport,
      score: m.score,
      minute: m.minute,
      periodLabel: m.periodLabel,
      misliUrl: m.misliUrl,
      at: new Date(now).toISOString(),
    }

    if (!p) {
      if (m.homeGoals + m.awayGoals > 0 || m.period === 'FIRST_HALF') {
        alerts.push({
          ...base,
          type: 'live_start',
          title: 'Canlı takip',
          message: `${m.home} vs ${m.away} canlıda · ${m.score} (${m.periodLabel || ''}${m.minute != null ? ` ${m.minute}'` : ''})`,
        })
      }
      continue
    }

    if (m.homeGoals > p.homeGoals) {
      alerts.push({
        ...base,
        type: 'goal',
        side: 'home',
        title: 'GOL!',
        message: `${m.home} gol attı → ${m.score} (${m.periodLabel || ''} ${m.minute ?? ''}')`,
      })
    }
    if (m.awayGoals > p.awayGoals) {
      alerts.push({
        ...base,
        type: 'goal',
        side: 'away',
        title: 'GOL!',
        message: `${m.away} gol attı → ${m.score} (${m.periodLabel || ''} ${m.minute ?? ''}')`,
      })
    }
    if (m.homeRed > p.homeRed) {
      alerts.push({
        ...base,
        type: 'red_card',
        side: 'home',
        title: 'Kırmızı kart',
        message: `${m.home} kırmızı kart · ${m.score}`,
      })
    }
    if (m.awayRed > p.awayRed) {
      alerts.push({
        ...base,
        type: 'red_card',
        side: 'away',
        title: 'Kırmızı kart',
        message: `${m.away} kırmızı kart · ${m.score}`,
      })
    }
    if (p.period !== m.period && m.period === 'HALF_TIME') {
      alerts.push({
        ...base,
        type: 'half_time',
        title: 'Devre arası',
        message: `${m.home} ${m.score} ${m.away} · İY`,
      })
    }
    if (p.period !== m.period && /SECOND_HALF|2\./i.test(m.period || '')) {
      alerts.push({
        ...base,
        type: 'second_half',
        title: '2. yarı',
        message: `${m.home} ${m.score} ${m.away} · 2. yarı başladı`,
      })
    }
    if (p.period !== m.period && /END|FINISH|FULL|COMPLETED/i.test(m.period || '')) {
      alerts.push({
        ...base,
        type: 'full_time',
        title: 'Maç bitti',
        message: `${m.home} ${m.score} ${m.away}`,
      })
    }
  }
  return alerts
}

export function createLiveWatcher({ intervalMs = 8000 } = {}) {
  let matches = []
  let alerts = []
  let prev = []
  let timer = null
  let updatedAt = null
  const listeners = new Set()

  async function tick() {
    try {
      const [compMap, soccer, basket] = await Promise.all([
        fetchCompetitionMap(),
        fetchBulletin('SOCCER', 'LIVE'),
        fetchBulletin('BASKETBALL', 'LIVE').catch(() => null),
      ])
      const next = [
        ...parseLiveBulletin(soccer, 'SOCCER', compMap),
        ...parseLiveBulletin(basket, 'BASKETBALL', compMap),
      ]
      next.sort((a, b) => (b.interest || 0) - (a.interest || 0))

      const fresh = prev.length ? diffAlerts(prev, next) : []
      if (fresh.length) {
        alerts = [...fresh, ...alerts].slice(0, 80)
        for (const a of fresh) {
          for (const fn of listeners) {
            try {
              fn(a)
            } catch {
              /* ignore */
            }
          }
        }
      }
      prev = next
      matches = next
      updatedAt = new Date().toISOString()
    } catch (e) {
      console.error('live tick', e.message || e)
    }
  }

  return {
    start() {
      if (timer) return
      void tick()
      timer = setInterval(() => void tick(), intervalMs)
    },
    stop() {
      if (timer) clearInterval(timer)
      timer = null
    },
    onAlert(fn) {
      listeners.add(fn)
      return () => listeners.delete(fn)
    },
    snapshot() {
      return {
        updatedAt,
        count: matches.length,
        matches,
        alerts: alerts.slice(0, 40),
      }
    },
  }
}

/** Matches still eligible for coupons: kickoff in the future, not live */
export function isUpcomingForCoupon(match, now = Date.now()) {
  if (match.live) return false
  const kick = match.kickoffMs || Date.parse(match.kickoff) || 0
  if (!kick) return false
  // kickoff anı geçmişse asla kupon havuzuna girme
  return kick > now
}
