import { fetchBulletin, fetchCompetitionMap } from '../lib/misli.mjs'
import { normalizeLiveEvent } from '../lib/live.mjs'

const [compMap, soccer, basket] = await Promise.all([
  fetchCompetitionMap(),
  fetchBulletin('SOCCER', 'LIVE'),
  fetchBulletin('BASKETBALL', 'LIVE'),
])

function collect(data, sportKey) {
  const events = data?.e || []
  let league = 'Diğer'
  const out = []
  for (const e of events) {
    if (!e.m?.length) {
      if (e.p?.[0]?.n) league = e.p[0].n
      continue
    }
    if (!e.l || !e.sc) continue
    const mapped = (e.cp && compMap.get(Number(e.cp))) || league
    const row = normalizeLiveEvent({ ...e, st: sportKey }, mapped)
    out.push(row)
  }
  return out
}

const all = [...collect(soccer, 'SOCCER'), ...collect(basket, 'BASKETBALL')]
all.sort((a, b) => (b.interest || 0) - (a.interest || 0))

const focus = all.filter((m) => (m.tips || []).some((t) => t.kind !== 'DURUM' && t.kind !== 'STRATEJİ' || t.odds)).slice(0, 12)
const list = (focus.length ? focus : all).slice(0, 12)

console.log(`CANLI OYNANABİLİR · ${all.length} maç · ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`)
console.log('='.repeat(56))

for (const m of list) {
  console.log(`\n${m.periodLabel}${m.minute != null ? ` ${m.minute}'` : ''} | ${m.league}`)
  console.log(`${m.home} ${m.score} ${m.away}`)
  const actionable = (m.tips || []).filter((t) => t.kind !== 'DURUM')
  for (const t of actionable.slice(0, 6)) {
    const odd = t.odds != null ? ` @${t.odds}` : ''
    const pick = t.pick ? `${t.pick}${odd} — ` : ''
    console.log(`  • [${t.kind}] ${pick}${t.text}`)
  }
  console.log(`  ↗ ${m.misliUrl}`)
}
