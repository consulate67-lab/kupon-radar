/**
 * Lig maçlarında öneriden önce: puan durumu, iç/dış saha, son maçlar, geçen sezon.
 * Kaynak: ESPN public scoreboard/standings (Misli bu veriyi vermez).
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_PATH = join(__dirname, '../../data/intel/espn-cache.json')
const TTL_MS = 6 * 60 * 60 * 1000

const LEAGUES = [
  { re: /türkiye süper lig|^süper lig$/i, slug: 'tur.1' },
  { re: /ingiltere premier lig/i, slug: 'eng.1' },
  { re: /ispanya la liga|laliga/i, slug: 'esp.1' },
  { re: /italya serie a/i, slug: 'ita.1' },
  { re: /almanya bundesliga(?!.*2)/i, slug: 'ger.1' },
  { re: /fransa ligue 1/i, slug: 'fra.1' },
  { re: /hollanda eredivisie/i, slug: 'ned.1' },
  { re: /portekiz (premier|primeira|liga)/i, slug: 'por.1' },
  { re: /belçika (pro|jupiler)/i, slug: 'bel.1' },
  { re: /iskoçya premiership/i, slug: 'sco.1' },
  { re: /\bmls\b|abd major league soccer/i, slug: 'usa.1' },
]

const mem = new Map()

function loadDisk() {
  try {
    if (!existsSync(CACHE_PATH)) return
    const raw = JSON.parse(readFileSync(CACHE_PATH, 'utf8'))
    for (const [k, v] of Object.entries(raw)) mem.set(k, v)
  } catch {
    /* ignore */
  }
}

function saveDisk() {
  try {
    mkdirSync(dirname(CACHE_PATH), { recursive: true })
    const obj = Object.fromEntries(mem)
    writeFileSync(CACHE_PATH, JSON.stringify(obj))
  } catch {
    /* ignore */
  }
}

loadDisk()

function norm(s = '') {
  return s
    .toLocaleLowerCase('tr-TR')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ı/g, 'i')
    .replace(/\b(fc|sk|fk|sc|cf|ac|afc|bk|jk)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function sameTeam(a, b) {
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y || x.includes(y) || y.includes(x)) return true
  const xt = new Set(x.split(' ').filter((t) => t.length > 2))
  const yt = y.split(' ').filter((t) => t.length > 2)
  const hit = yt.filter((t) => xt.has(t)).length
  return hit >= 1 && hit >= Math.min(xt.size, yt.length)
}

export function leagueSlug(league = '') {
  if (/kupa|cup|eleme|play-?off|hazırlık|friendly|u19|u21|u23|kadın/i.test(league)) return null
  return LEAGUES.find((l) => l.re.test(league))?.slug || null
}

function seasons() {
  const now = new Date()
  const y = now.getUTCFullYear()
  const start = now.getUTCMonth() >= 6 ? y : y - 1
  return [start, start - 1]
}

async function cached(key, loader) {
  const hit = mem.get(key)
  if (hit && Date.now() - hit.at < TTL_MS) return hit.data
  const data = await loader()
  mem.set(key, { at: Date.now(), data })
  saveDisk()
  return data
}

async function espn(path) {
  const res = await fetch(`https://site.api.espn.com${path}`, {
    headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
  })
  if (!res.ok) throw new Error(`espn ${res.status}`)
  return res.json()
}

async function standings(slug) {
  return cached(`table:${slug}`, async () => {
    const json = await espn(`/apis/v2/sports/soccer/${slug}/standings`)
    const entries = json.children?.[0]?.standings?.entries || []
    return entries.map((e) => {
      const stat = (name) => e.stats?.find((s) => s.name === name || s.abbreviation === name)
      return {
        id: String(e.team?.id || ''),
        name: e.team?.displayName || e.team?.name || '',
        rank: Number(stat('rank')?.value ?? 0),
        points: Number(stat('points')?.value ?? 0),
        played: Number(stat('gamesPlayed')?.value ?? 0),
        gd: Number(stat('pointDifferential')?.value ?? 0),
        gf: Number(stat('pointsFor')?.value ?? 0),
        ga: Number(stat('pointsAgainst')?.value ?? 0),
        form: stat('form')?.displayValue || e.team?.form || '',
      }
    })
  })
}

async function schedule(slug, teamId, season) {
  return cached(`sched:${slug}:${teamId}:${season}`, async () => {
    const json = await espn(
      `/apis/site/v2/sports/soccer/${slug}/teams/${teamId}/schedule?season=${season}`,
    )
    const games = []
    for (const ev of json.events || []) {
      const c = ev.competitions?.[0]
      if (!c?.status?.type?.completed) continue
      const home = c.competitors?.find((t) => t.homeAway === 'home')
      const away = c.competitors?.find((t) => t.homeAway === 'away')
      if (!home || !away) continue
      games.push({
        date: (ev.date || '').slice(0, 10),
        season,
        home: home.team?.displayName || '',
        away: away.team?.displayName || '',
        hs: Number(home.score?.value ?? home.score ?? 0),
        as: Number(away.score?.value ?? away.score ?? 0),
      })
    }
    games.sort((a, b) => a.date.localeCompare(b.date))
    return games
  })
}

function resultOf(game, teamName) {
  const home = sameTeam(game.home, teamName)
  const gf = home ? game.hs : game.as
  const ga = home ? game.as : game.hs
  const r = gf > ga ? 'G' : gf < ga ? 'M' : 'B'
  return { r, gf, ga, home, label: `${game.home} ${game.hs}-${game.as} ${game.away}` }
}

function formLine(games, teamName) {
  return games
    .map((g) => resultOf(g, teamName).r)
    .join('')
}

function findRow(table, name) {
  return table.find((r) => sameTeam(r.name, name)) || null
}

export async function buildLeagueContext(home, away, league) {
  const slug = leagueSlug(league)
  if (!slug) return null
  try {
    const table = await standings(slug)
    const h = findRow(table, home)
    const a = findRow(table, away)
    if (!h && !a) return null
    const [cur, prev] = seasons()
    const packs = await Promise.all(
      [h, a]
        .filter(Boolean)
        .flatMap((row) => [schedule(slug, row.id, cur), schedule(slug, row.id, prev)]),
    )
    const games = packs.flat().filter(Boolean)
    const uniq = []
    const seen = new Set()
    for (const g of games) {
      const k = `${g.date}|${g.home}|${g.away}`
      if (seen.has(k)) continue
      seen.add(k)
      uniq.push(g)
    }
    uniq.sort((x, y) => x.date.localeCompare(y.date))

    const homeGames = h ? uniq.filter((g) => sameTeam(g.home, h.name) || sameTeam(g.away, h.name)) : []
    const awayGames = a ? uniq.filter((g) => sameTeam(g.home, a.name) || sameTeam(g.away, a.name)) : []
    const homeAtHome = homeGames.filter((g) => sameTeam(g.home, h.name)).slice(-5)
    const awayAtAway = awayGames.filter((g) => sameTeam(g.away, a.name)).slice(-5)
    const h2h = uniq
      .filter(
        (g) =>
          (sameTeam(g.home, home) && sameTeam(g.away, away)) ||
          (sameTeam(g.away, home) && sameTeam(g.home, away)),
      )
      .slice(-6)

    const avgGoals = (list, team) => {
      if (!list.length || !team) return null
      const s = list.slice(-5).reduce((n, g) => n + resultOf(g, team.name).gf + resultOf(g, team.name).ga, 0)
      return s / Math.min(5, list.length)
    }

    const ctx = {
      slug,
      tableSize: table.length,
      home: h,
      away: a,
      homeRecent: formLine(homeGames.slice(-5), h?.name),
      awayRecent: formLine(awayGames.slice(-5), a?.name),
      homeAtHome: formLine(homeAtHome, h?.name),
      awayAtAway: formLine(awayAtAway, a?.name),
      homeAtHomeScores: homeAtHome.map((g) => `${g.hs}-${g.as}`),
      awayAtAwayScores: awayAtAway.map((g) => `${g.hs}-${g.as}`),
      h2h: h2h.map((g) => `${g.season} ${g.home} ${g.hs}-${g.as} ${g.away}`),
      avgGoalsHome: avgGoals(homeGames, h),
      avgGoalsAway: avgGoals(awayGames, a),
    }
    ctx.summary = summarize(ctx)
    return ctx
  } catch {
    return null
  }
}

function summarize(ctx) {
  const bits = []
  if (ctx.home) bits.push(`Ev ${ctx.home.rank}. sıra ${ctx.home.points}p`)
  if (ctx.away) bits.push(`dep ${ctx.away.rank}. sıra ${ctx.away.points}p`)
  if (ctx.homeAtHome) bits.push(`iç saha son ${ctx.homeAtHome} (${ctx.homeAtHomeScores.join(', ')})`)
  if (ctx.awayAtAway) bits.push(`dış saha son ${ctx.awayAtAway} (${ctx.awayAtAwayScores.join(', ')})`)
  if (ctx.homeRecent) bits.push(`ev son ${ctx.homeRecent}`)
  if (ctx.awayRecent) bits.push(`dep son ${ctx.awayRecent}`)
  if (ctx.h2h?.length) bits.push(`H2H ${ctx.h2h.slice(-3).join(' | ')}`)
  return bits.join(' · ')
}

export function leagueBias(pick, ctx) {
  if (!ctx || !pick) return 0
  let d = 0
  const kind = pick.marketKind
  const side = pick.outcomeName
  const homeBetter =
    ctx.home && ctx.away && ctx.home.rank && ctx.away.rank && ctx.home.rank + 3 < ctx.away.rank
  const awayBetter =
    ctx.home && ctx.away && ctx.home.rank && ctx.away.rank && ctx.away.rank + 3 < ctx.home.rank
  const homeHomeStrong = (ctx.homeAtHome || '').replace(/[^G]/g, '').length >= 3
  const awayAwayWeak = (ctx.awayAtAway || '').replace(/[^M]/g, '').length >= 3
  const avg = [ctx.avgGoalsHome, ctx.avgGoalsAway].filter((n) => n != null)
  const lowScoring = avg.length && avg.every((n) => n < 2.3)
  const highScoring = avg.length && avg.every((n) => n > 3)

  if (kind === 'ms' || kind === 'cs') {
    if (homeBetter || homeHomeStrong) {
      if (side === '1' || side === '1X') d += 10
      if (side === '2') d -= 12
    }
    if (awayBetter) {
      if (side === '2' || side === 'X2') d += 10
      if (side === '1') d -= 10
    }
    if (awayAwayWeak && (side === '2' || side === 'X2')) d -= 8
    if (homeHomeStrong && awayAwayWeak && side === '1') d += 6
  }
  if (kind === 'ou' || kind === 'ou25') {
    if (lowScoring && /Alt/i.test(pick.shortPick || side || '')) d += 8
    if (lowScoring && /Üst/i.test(pick.shortPick || '')) d -= 8
    if (highScoring && /Üst/i.test(pick.shortPick || '')) d += 8
    if (highScoring && /Alt/i.test(pick.shortPick || '')) d -= 6
  }
  if (kind === 'kg') {
    if (lowScoring && /Var/i.test(pick.shortPick || side || '')) d -= 8
    if (lowScoring && /Yok/i.test(pick.shortPick || '')) d += 6
    if (highScoring && /Var/i.test(pick.shortPick || '')) d += 6
  }
  return d
}

export function leagueNote(ctx) {
  if (!ctx?.summary) return ''
  return `Puan/form: ${ctx.summary}.`
}

/** Canlı öneri: skor hâlâ öncelikli; form sadece çelişirse önceliği kırar. */
export function liveTipDelta(tip, ctx) {
  if (!ctx || !tip?.pick) return 0
  const fake = {
    marketKind: /MS|ÇŞ/.test(tip.kind) ? 'ms' : /A\/Ü/.test(tip.kind) ? 'ou' : /KG/.test(tip.kind) ? 'kg' : 'other',
    outcomeName: /MS 1|1X/.test(tip.pick) ? '1' : /MS 2|X2/.test(tip.pick) ? '2' : tip.pick,
    shortPick: tip.pick,
  }
  return Math.round(leagueBias(fake, ctx) * 0.6)
}

const pairMem = new Map()

export function peekLeagueContext(home, away, league) {
  return pairMem.get(`${norm(home)}|${norm(away)}|${leagueSlug(league) || ''}`) || null
}

export async function attachLeagueContexts(matches, limit = 8) {
  const targets = []
  for (const m of matches) {
    if (m.sport && m.sport !== 'football') continue
    if (!leagueSlug(m.league)) continue
    targets.push(m)
    if (targets.length >= limit) break
  }
  for (const m of targets) {
    const ctx = await buildLeagueContext(m.home, m.away, m.league)
    if (!ctx) continue
    m.leagueContext = ctx
    pairMem.set(`${norm(m.home)}|${norm(m.away)}|${ctx.slug}`, ctx)
  }
  return targets.length
}
