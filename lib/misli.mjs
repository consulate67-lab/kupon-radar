const BASE = 'https://apivx.misli.com/api/web'
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  Origin: 'https://www.misli.com',
  Referer: 'https://www.misli.com/',
}

async function misliGet(path) {
  const res = await fetch(`${BASE}${path}`, { headers: HEADERS })
  if (!res.ok) throw new Error(`Misli GET ${path} → ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error(`Misli GET ${path} unsuccessful`)
  return json.data
}

async function misliPost(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Misli POST ${path} → ${res.status}`)
  const json = await res.json()
  if (!json.success) throw new Error(`Misli POST ${path} unsuccessful`)
  return json.data
}

export async function fetchBulletin(sportType = 'SOCCER', betType = 'PRE_EVENT') {
  return misliGet(`/v1/sportsbook/event/0?sportType=${sportType}&betType=${betType}`)
}

export async function fetchEventFull(eventId) {
  return misliGet(`/v2/sportsbook/event/${eventId}/single`)
}

export async function fetchPlayRatio(eventId) {
  try {
    return await misliGet(`/v1/sportsbook/play-ratio/event/${eventId}`)
  } catch {
    return []
  }
}

/** Build competitionId → league name from left-menu tree */
export function buildCompetitionMap(menuData) {
  const map = new Map()
  const walk = (nodes) => {
    if (!Array.isArray(nodes)) return
    for (const n of nodes) {
      if (n?.i != null && n?.n && (n.sn || n.c || typeof n.i === 'number')) {
        // leaf competitions usually numeric id
        if (typeof n.i === 'number' || /^\d+$/.test(String(n.i))) {
          map.set(Number(n.i), n.n)
        }
      }
      if (n?.c) walk(n.c)
    }
  }
  walk(menuData)
  return map
}

export async function fetchCompetitionMap() {
  try {
    const menu = await misliGet('/v1/sportsbook/left-menu?type=PRE_EVENT')
    return buildCompetitionMap(menu)
  } catch {
    return new Map()
  }
}

/** Flatten bulletin into match rows with league context */
export function parseBulletin(data, sport, competitionMap = new Map()) {
  const events = data?.e || []
  let headerLeague = null
  const matches = []

  for (const e of events) {
    if (!e.m || !Array.isArray(e.m) || !e.m.length) {
      if (e.p?.[0]?.n) headerLeague = e.p[0].n
      else if (e.n) headerLeague = e.n.split(' - ')[0]
      continue
    }

    // Misli PRE_EVENT'te event.s çoğu zaman CLOSED gelir; market OPEN ise bahis açıktır
    const openMarkets = e.m.filter((m) => m.st === 'OPEN' || m.st == null || m.st === 1 || m.s === 1 || m.o?.length)
    if (!openMarkets.length) continue

    const home = e.p?.[0]?.n || e.ph || e.n?.split(' - ')[0] || '?'
    const away = e.p?.[1]?.n || e.pa || e.n?.split(' - ')[1] || '?'
    const league =
      (e.cp && competitionMap.get(Number(e.cp))) ||
      headerLeague ||
      'Diğer'

    matches.push({
      eventId: e.i,
      sport: sport === 'BASKETBALL' ? 'basketball' : 'football',
      sportType: sport,
      competitionId: e.cp || null,
      league,
      home,
      away,
      name: e.n || `${home} - ${away}`,
      kickoffMs: e.d,
      kickoff: new Date(e.d).toISOString(),
      live: !!e.l,
      mbs: e.mbs || e.mbc || 1,
      bulletinMarkets: openMarkets.map(normalizeMarket),
    })
  }
  return matches
}

function normalizeMarket(m) {
  return {
    id: m.i || m.id,
    name: m.n,
    type: m.t,
    subType: m.sbt ?? m.st ?? m.s,
    line: m.ov != null ? String(m.ov) : null,
    status: m.s,
    outcomes: (m.o || [])
      .filter((o) => typeof o.od === 'number' && o.od >= 1.01)
      .map((o) => ({
        no: o.on,
        name: normalizeOutcomeName(o.n, m.n),
        odds: o.od,
        prev: o.lodd ?? o.p ?? null,
      })),
  }
}

function normalizeOutcomeName(name, marketName = '') {
  if (name === '0' && /Maç Sonucu|Handikap|İlk Yarı Sonucu|İkinci Yarı/i.test(marketName)) return 'X'
  if (name === '1 ve 0') return '1X'
  if (name === '1 ve 2') return '12'
  if (name === '0 ve 2') return 'X2'
  return name
}

export function classifyMarket(name = '') {
  const n = name.toLocaleLowerCase('tr-TR')
  if (/ev sahibi|deplasman|oyuncu|korner|kart|faul|ofsayt|şut|asist|penaltı|kırmızı/.test(n)) {
    if (/^karşılıklı gol$/.test(n)) return 'kg'
    return 'other'
  }
  if (/^maç sonucu$/.test(n)) return 'ms'
  if (/^çifte şans$/.test(n)) return 'cs'
  if (/^karşılıklı gol$/.test(n)) return 'kg'
  if (/^altı\/üstü 2[,.]5$/.test(n)) return 'ou25'
  if (/^altı\/üstü \d/.test(n)) return 'ou'
  if (/^handikap/.test(n)) return 'ah'
  if (/^ilk yarı sonucu$/.test(n)) return 'iy'
  if (/ilk yarı\/maç sonucu/.test(n) && !/skor/.test(n)) return 'iy_ms'
  if (/^tek\/çift$/.test(n)) return 'odd_even'
  if (/^maç sonucu ve karşılıklı gol$/.test(n)) return 'ms_kg'
  if (/^maç sonucu ve altı\/üstü/.test(n)) return 'ms_ou'
  if (/korner/.test(n)) return 'corner'
  if (/kart/.test(n)) return 'card'
  if (/oyuncu|golü atan|asist|şut/.test(n)) return 'player'
  return 'other'
}

export const MARKET_WEIGHT = {
  ms: 1.15,
  cs: 1.05,
  ou25: 1.1,
  ou: 1.0,
  kg: 1.05,
  ah: 0.95,
  iy: 0.9,
  iy_ms: 0.85,
  odd_even: 0.75,
  ms_kg: 0.9,
  ms_ou: 0.88,
  corner: 0.55,
  card: 0.5,
  player: 0.45,
  other: 0.4,
}

export async function enrichWithFullMarkets(matches, limit = 30) {
  const pool = matches.slice(0, limit)
  const out = []
  for (let i = 0; i < pool.length; i += 4) {
    const chunk = pool.slice(i, i + 4)
    const results = await Promise.all(
      chunk.map(async (m) => {
        try {
          const [full, ratios] = await Promise.all([
            fetchEventFull(m.eventId),
            fetchPlayRatio(m.eventId),
          ])
          const markets = (full?.m || []).map(normalizeMarket).filter((x) => x.outcomes.length)
          const ratioMap = {}
          for (const r of ratios || []) {
            ratioMap[`${r.mi}-${r.on}`] = r.r
          }
          return {
            ...m,
            home: full?.ph || m.home,
            away: full?.pa || m.away,
            live: full?.l ?? m.live,
            markets,
            playRatios: ratioMap,
            marketCount: markets.length,
          }
        } catch {
          return {
            ...m,
            markets: m.bulletinMarkets || [],
            playRatios: {},
            marketCount: (m.bulletinMarkets || []).length,
          }
        }
      }),
    )
    out.push(...results)
    if (i + 4 < pool.length) await new Promise((r) => setTimeout(r, 80))
  }
  return out
}
