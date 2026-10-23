import express from 'express'
import { existsSync } from 'node:fs'
import cors from 'cors'
import { createServer as createViteServer } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import {
  fetchBulletin,
  parseBulletin,
  enrichWithFullMarkets,
  fetchCompetitionMap,
} from './lib/misli.mjs'
import {
  analyzeMatch,
  buildCoupon,
  preliminaryRank,
  isUpcomingKickoff,
  istanbulDateKey,
  shiftDateKey,
} from './lib/analyze.mjs'
import { createLiveWatcher } from './lib/live.mjs'
import { buildSeriesPlan } from './lib/series.mjs'
import { attachLeagueContexts } from './lib/intel/leagueForm.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let cache = { at: 0, data: null }
const CACHE_MS = 75_000
const liveWatcher = createLiveWatcher({ intervalMs: 8000 })

async function loadSlate() {
  // Kupon havuzu: sadece PRE_EVENT (canlı / başlamış maç yok)
  const [compMap, soccerPre, basketPre, soccerLive, basketLive] = await Promise.all([
    fetchCompetitionMap(),
    fetchBulletin('SOCCER', 'PRE_EVENT'),
    fetchBulletin('BASKETBALL', 'PRE_EVENT'),
    fetchBulletin('SOCCER', 'LIVE').catch(() => null),
    fetchBulletin('BASKETBALL', 'LIVE').catch(() => null),
  ])

  const now = Date.now()
  let matches = [
    ...parseBulletin(soccerPre, 'SOCCER', compMap),
    ...parseBulletin(basketPre, 'BASKETBALL', compMap),
    ...parseBulletin(soccerLive, 'SOCCER', compMap),
    ...parseBulletin(basketLive, 'BASKETBALL', compMap),
  ]

  const byId = new Map()
  for (const m of matches) {
    const prev = byId.get(m.eventId)
    if (!prev || (m.bulletinMarkets?.length || 0) > (prev.bulletinMarkets?.length || 0)) {
      byId.set(m.eventId, m)
    }
  }

  matches = [...byId.values()]
    .filter((m) => isUpcomingKickoff(m, now))
    .map((m) => ({ ...m, preScore: preliminaryRank(m) }))

  // Bu gece → yarın öğlen (İstanbul): günü yarına bağlayan maçlar skorda ezilmesin
  const tomorrowNoon = Date.parse(`${shiftDateKey(istanbulDateKey(now), 1)}T09:00:00.000Z`)
  const night = matches
    .filter((m) => m.kickoffMs <= tomorrowNoon)
    .sort((a, b) => a.kickoffMs - b.kickoffMs || b.preScore - a.preScore)
  const later = matches
    .filter((m) => m.kickoffMs > tomorrowNoon)
    .sort((a, b) => b.preScore - a.preScore)
  matches = [...night, ...later]

  const enrichLimit = Math.min(72, night.length + 28)
  const enriched = await enrichWithFullMarkets(matches, enrichLimit)
  const enrichedIds = new Set(enriched.map((m) => m.eventId))
  // Tam kartı çekilmeyen bu gece maçları bülten marketiyle yine havuza girer
  const nightRest = night
    .filter((m) => !enrichedIds.has(m.eventId))
    .map((m) => ({ ...m, markets: m.bulletinMarkets || [] }))
  const prepared = [...enriched, ...nightRest]
  await attachLeagueContexts(prepared, 8)
  const analyzed = prepared
    .map((m) => analyzeMatch(m) || analyzeMatch({ ...m, markets: m.bulletinMarkets || [] }))
    .filter(Boolean)
    .filter((m) => isUpcomingKickoff(m, Date.now()))
  const nightCut = Date.parse(`${shiftDateKey(istanbulDateKey(Date.now()), 1)}T09:00:00.000Z`)
  analyzed.sort((a, b) => {
    const aNight = (a.kickoffMs || 0) <= nightCut
    const bNight = (b.kickoffMs || 0) <= nightCut
    if (aNight !== bNight) return aNight ? -1 : 1
    if (aNight && bNight) return (a.kickoffMs || 0) - (b.kickoffMs || 0)
    return (b.score || 0) - (a.score || 0)
  })

  return {
    updatedAt: new Date().toISOString(),
    timezone: 'Europe/Istanbul',
    source: 'Misli.com (apivx.misli.com)',
    sourceUrl: 'https://www.misli.com/iddaa/futbol',
    bulletinCount: matches.length,
    matches: analyzed,
    marketKinds: [
      'Maç Sonucu',
      'Çifte Şans',
      'Alt/Üst',
      'Karşılıklı Gol',
      'Handikap',
      'İlk Yarı',
      'Kombine (MS+AU / MS+KG)',
    ],
  }
}

async function getSlate(force = false) {
  if (!force && cache.data && Date.now() - cache.at < CACHE_MS) {
    // cache içinde bile kickoff geçmişleri anında düş
    const now = Date.now()
    return {
      ...cache.data,
      matches: cache.data.matches.filter((m) => isUpcomingKickoff(m, now)),
    }
  }
  const data = await loadSlate()
  cache = { at: Date.now(), data }
  return data
}

async function start() {
  const app = express()
  app.use(cors())
  app.use(express.json())

  liveWatcher.start()

  app.get('/api/health', (_req, res) => res.json({ ok: true, source: 'misli', live: true }))

  app.get('/api/matches', async (_req, res) => {
    try {
      const slate = await getSlate()
      res.json(slate)
    } catch (e) {
      console.error(e)
      res.status(502).json({ error: String(e.message || e) })
    }
  })

  app.post('/api/coupon', async (req, res) => {
    try {
      const slate = await getSlate()
      const matchCount = Math.min(10, Math.max(1, Number(req.body.matchCount) || 4))
      const minOdds = Math.max(1.01, Number(req.body.minOdds) || 1.3)
      const minTotalOdds = Math.max(1, Number(req.body.minTotalOdds) || 1)
      const sports = req.body.sports || 'all'
      const marketFocus = req.body.marketFocus || 'all'
      const dateMode = req.body.dateMode || 'all'
      const dateFrom = req.body.dateFrom || null
      const dateTo = req.body.dateTo || null
      const coupon = buildCoupon(slate.matches, {
        matchCount,
        minOdds,
        minTotalOdds,
        sports,
        marketFocus,
        dateMode,
        dateFrom,
        dateTo,
      })
      res.json({
        updatedAt: slate.updatedAt,
        source: slate.source,
        coupon,
        poolSize: slate.matches.length,
        filteredPool: coupon.legs?.length,
      })
    } catch (e) {
      console.error(e)
      res.status(502).json({ error: String(e.message || e) })
    }
  })

  app.post('/api/series', async (req, res) => {
    try {
      const slate = await getSlate()
      const plan = buildSeriesPlan(slate.matches, {
        startBank: Number(req.body.startBank) || 50,
        unitStake: Number(req.body.unitStake) || 50,
        parallel: Number(req.body.parallel) || 2,
        rounds: Number(req.body.rounds) || 6,
        targetOdds: Number(req.body.targetOdds) || 2.05,
        sports: req.body.sports || 'all',
      })
      res.json({
        updatedAt: slate.updatedAt,
        source: slate.source,
        plan,
        poolSize: slate.matches.length,
      })
    } catch (e) {
      console.error(e)
      res.status(502).json({ error: String(e.message || e) })
    }
  })

  app.get('/api/live', (_req, res) => {
    res.json(liveWatcher.snapshot())
  })

  app.get('/api/live/stream', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.flushHeaders?.()

    const snap = liveWatcher.snapshot()
    res.write(`event: snapshot\ndata: ${JSON.stringify(snap)}\n\n`)

    const sendAlert = (alert) => {
      res.write(`event: alert\ndata: ${JSON.stringify(alert)}\n\n`)
    }
    const sendTick = () => {
      res.write(`event: tick\ndata: ${JSON.stringify(liveWatcher.snapshot())}\n\n`)
    }

    const off = liveWatcher.onAlert(sendAlert)
    const tickTimer = setInterval(sendTick, 10000)
    req.on('close', () => {
      off()
      clearInterval(tickTimer)
    })
  })

  app.post('/api/refresh', async (_req, res) => {
    try {
      const slate = await getSlate(true)
      res.json({ ok: true, count: slate.matches.length, updatedAt: slate.updatedAt })
    } catch (e) {
      res.status(502).json({ error: String(e.message || e) })
    }
  })

  const distDir = path.join(__dirname, 'dist')
  const distIndex = path.join(distDir, 'index.html')
  if (process.env.NODE_ENV === 'production' && !existsSync(distIndex)) {
    const { build } = await import('vite')
    await build({ root: __dirname })
  }

  if (process.env.NODE_ENV === 'production' && existsSync(distIndex)) {
    app.use(express.static(distDir))
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api')) return next()
      res.sendFile(distIndex)
    })
  } else {
    const vite = await createViteServer({
      root: __dirname,
      server: { middlewareMode: true, allowedHosts: true },
      appType: 'custom',
    })
    app.use(vite.middlewares)

    app.use(async (req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.includes('.')) {
        return next()
      }
      try {
        const fs = await import('fs/promises')
        const template = await vite.transformIndexHtml(
          req.originalUrl,
          await fs.readFile(path.join(__dirname, 'index.html'), 'utf-8'),
        )
        res.status(200).set({ 'Content-Type': 'text/html' }).end(template)
      } catch (e) {
        vite.ssrFixStacktrace(e)
        next(e)
      }
    })
  }

  const port = Number(process.env.PORT) || 5174
  app.listen(port, () => {
    console.log(`Kupon Radar (Misli + Canlı) → http://localhost:${port}`)
  })
}

start().catch((e) => {
  console.error(e)
  process.exit(1)
})
