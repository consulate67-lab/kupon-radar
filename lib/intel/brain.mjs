/**
 * Skor + kalan süre öncelikli canlı akıl.
 * Piyasa (Misli) ikinci sırada; çelişirse skor kazanır.
 * lessons.json içine yazılan kurallar zamanla birikir.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const LESSONS_PATH = join(__dirname, '../../data/intel/lessons.json')

const BUILTIN_LESSONS = [
  {
    id: 'no-draw-when-leading-late',
    when: 'min>=75 && hg!==ag',
    never: 'MS X',
    prefer: 'lider MS',
    why: 'Geç dakika önde olan tarafın berabere bitmesi düşük olasılık; X pahalıysa daha da anlamsız.',
  },
  {
    id: 'no-kg-var-one-nil-late',
    when: 'min>=75 && oneSided',
    never: 'KG Var',
    prefer: 'KG Yok / lider MS / Alt',
    why: 'Suskun tarafın golü için süre yetmez; oran uzunsa piyasa da aynı şeyi söyler.',
  },
  {
    id: 'incomplete-ms-market',
    when: 'msSides<3',
    never: 'piyasa lean',
    prefer: 'skor durumu',
    why: 'Askıdaki favori kalınca X/2 sahte yüksek % üretir.',
  },
  {
    id: 'odds-prob-consistency',
    when: 'od>=3 && claimedProb>0.4',
    never: 'o tip',
    prefer: 'reddet',
    why: '@5.59 ile %75 aynı anda olamaz.',
  },
  {
    id: 'stoke-nords-u21-msx-trap-2026-10-20',
    when: 'U21 && 0-0 && rem>15 && MS X @~1.50',
    never: 'MS X',
    prefer: 'Alt 2.5 / KG Yok / 80+ bekle',
    why: 'Stoke U21–Nordsjælland U21: HT 0-0, canlı MS X @1.51 → FT 0-2. Kısa X + bol süre + gençlik = tuzak. Aynı Stoke HT 0-0→0-2 (Gladbach II) kalıbı vardı. Alt 2.5 (2 gol) ve KG Yok tutardı.',
  },
  {
    id: 'short-draw-with-time-left',
    when: 'MS X od<1.55 && rem>15',
    never: 'MS X',
    prefer: 'Alt / KG Yok veya bekle',
    why: 'Kısa beraberlik oranı “garanti” gibi görünür; süre varken 2. yarı golü X’i yakar.',
  },
  {
    id: 'youth-no-early-msx',
    when: 'U19|U21|Reserves|II && min<82',
    never: 'MS X',
    prefer: 'gol piyasası',
    why: 'Gençlik maçları 2. yarıda açılır; erken/orta MS X yüksek varyans.',
  },
]

function loadLessons() {
  try {
    if (!existsSync(LESSONS_PATH)) return [...BUILTIN_LESSONS]
    const raw = JSON.parse(readFileSync(LESSONS_PATH, 'utf8'))
    const extra = Array.isArray(raw.learned) ? raw.learned : []
    return [...BUILTIN_LESSONS, ...extra]
  } catch {
    return [...BUILTIN_LESSONS]
  }
}

export function rememberLesson(lesson) {
  try {
    mkdirSync(dirname(LESSONS_PATH), { recursive: true })
    let raw = { learned: [] }
    if (existsSync(LESSONS_PATH)) {
      raw = JSON.parse(readFileSync(LESSONS_PATH, 'utf8'))
      if (!Array.isArray(raw.learned)) raw.learned = []
    }
    if (raw.learned.some((x) => x.id === lesson.id)) return
    raw.learned.push({ ...lesson, at: new Date().toISOString() })
    raw.updatedAt = new Date().toISOString()
    writeFileSync(LESSONS_PATH, JSON.stringify(raw, null, 2), 'utf8')
  } catch {
    /* ignore disk errors */
  }
}

export function remainingMinutes(min, period) {
  const m = Number(min) || 0
  if (/HALF_TIME/i.test(period || '')) return 45
  if (/FIRST_HALF/i.test(period || '') || m <= 45) return Math.max(48 - Math.min(m, 45), 1)
  if (m >= 90) return Math.max(3, 95 - m)
  return Math.max(90 + 3 - m, 1)
}

/** U19 / U21 / rezerv / II — yüksek varyans */
export function isYouthMatch(m) {
  const blob = `${m.home || ''} ${m.away || ''} ${m.league || ''}`
  return /U19|U20|U21|U23|Genç|Youth|Reserves|\bII\b|\b2\b|Amateur|Ümit/i.test(blob)
}

/** Oran ↔ olasılık tutarlı mı? */
export function oddsProbSane(od, prob) {
  if (typeof od !== 'number' || typeof prob !== 'number') return false
  if (od < 1.05 || od > 25) return false
  if (prob < 0.08 || prob > 0.92) return false
  // Kabaca: fair ≈ 1/od; de-vig sapmaya izin ver
  const implied = 1 / od
  if (prob > implied * 2.2 + 0.05) return false
  if (od >= 3 && prob > 0.4) return false
  if (od >= 4.5 && prob > 0.28) return false
  if (od <= 1.35 && prob < 0.5) return false
  return true
}

function msSide(n) {
  if (n === '1' || n === 1) return '1'
  if (n === '2' || n === 2) return '2'
  if (n === '0' || n === 'X' || n === 'x') return 'X'
  return null
}

/**
 * Skor durumundan sonuç prior'u (piyasadan bağımsız).
 * @returns {{ pick: string, confidence: number, reason: string } | null}
 */
export function scoreResultPrior(m) {
  const min = m.min ?? 0
  const hg = m.hg || 0
  const ag = m.ag || 0
  const rem = remainingMinutes(min, m.period)
  const lead = hg - ag
  const youth = isYouthMatch(m)
  // Gençlikte X daha geç; kısa X + süre varsa hiç önerme
  const drawGate = youth ? 85 : 82

  if (hg === ag) {
    if (min >= drawGate && rem <= 12) {
      return {
        pick: 'MS X',
        confidence: youth ? 0.58 : Math.min(0.7, 0.52 + (min - drawGate) * 0.025),
        reason: `${min}' eşitlik (${m.score}), kalan ~${rem}'${youth ? ' · U21/gençlik: geç X temkinli' : ''}.`,
      }
    }
    return null
  }

  const leaderPick = lead > 0 ? 'MS 1' : 'MS 2'
  const leaderName = lead > 0 ? m.home : m.away
  const margin = Math.abs(lead)

  // 75+ önde → sonuç prior güçlü; X yasak
  if (min >= 75) {
    const conf =
      margin >= 2
        ? 0.88
        : min >= 85
          ? 0.82
          : min >= 80
            ? 0.76
            : 0.68
    return {
      pick: leaderPick,
      confidence: conf,
      reason: `${min}' ${m.score}: ${leaderName} önde, kalan ~${rem}'. En doğru sonuç prior'u lider MS — berabere değil.`,
    }
  }

  if (min >= 60 && margin >= 2) {
    return {
      pick: leaderPick,
      confidence: 0.7,
      reason: `${min}' ${margin} fark: lider MS.`,
    }
  }

  return null
}

/**
 * Piyasa lean'ini skor + tutarlılık süzgecinden geçir.
 */
export function filterMarketLean(fav, m, outs) {
  if (!fav) return null
  const side = msSide(fav.n)
  if (!side) return null

  const home = outs.find((o) => msSide(o.n) === '1')
  const draw = outs.find((o) => msSide(o.n) === 'X')
  const away = outs.find((o) => msSide(o.n) === '2')
  const sides = [home, draw, away].filter((o) => o && typeof o.od === 'number').length

  if (sides < 3) {
    rememberLesson({
      id: `incomplete-ms-${m.eventId || 'x'}`,
      tip: 'incomplete-ms-market',
      detail: `${m.home} vs ${m.away} ${m.score} ${m.min}' — MS tarafı ${sides}/3`,
    })
    return null
  }

  if (!oddsProbSane(fav.od, fav.prob)) {
    rememberLesson({
      id: `insane-odds-${m.eventId || 'x'}-${fav.od}`,
      tip: 'odds-prob-consistency',
      detail: `@${fav.od} ile %${Math.round(fav.prob * 100)} çelişkisi reddedildi`,
    })
    return null
  }

  // Önde iken asla X
  if (side === 'X' && (m.hg || 0) !== (m.ag || 0)) {
    rememberLesson({
      id: `draw-while-leading-${m.eventId || 'x'}`,
      tip: 'no-draw-when-leading-late',
      detail: `${m.min}' ${m.score} → MS X engellendi`,
    })
    return null
  }

  const min = m.min ?? 0
  const rem = remainingMinutes(min, m.period)
  const youth = isYouthMatch(m)

  // Stoke–Nords tuzağı: kısa X + süre varken / gençlik erken X
  if (side === 'X') {
    if (youth && min < 85) return null
    if (rem > 15) return null
    if (fav.od < 1.55 && rem > 10) return null
    if (min < 80) return null
  }

  if (min >= 80 && side === 'X' && fav.od > 2.5) return null

  return { ...fav, side }
}

/**
 * 0-0 / düşük tempolu senaryoda MS X yerine daha az riskli yön.
 * Stoke–Nords: Alt 2.5 ve KG Yok tuttu, MS X yanıldı.
 */
export function saferThanDraw(m, markets = []) {
  const hg = m.hg || 0
  const ag = m.ag || 0
  const min = m.min ?? 0
  const rem = remainingMinutes(min, m.period)
  if (hg !== ag) return null
  if (rem <= 12 && min >= 82) return null // o noktada X zaten skor prior

  const find = (re) => markets.find((x) => re.test(x.n))
  const kg = find(/^Karşılıklı Gol$/i)
  const ou25 = markets.find((x) => /Altı\/Üstü 2[,.]5/i.test(x.n) && !/Ev|Dep|İlk|Korner/i.test(x.n))
  const tips = []

  const total = hg + ag
  if (ou25 && total <= 2) {
    const alt = (ou25.o || []).find((o) => /^Alt$/i.test(o.n))
    if (alt && alt.od >= 1.2 && alt.od <= 2.4) {
      tips.push({
        kind: 'A/Ü',
        pick: 'Alt 2.5',
        odds: alt.od,
        priority: 83,
        text: `${min}' ${m.score}: MS X yerine Alt 2.5 (kısa X tuzağı / 2. yarı gol riski). Stoke–Nords dersi.`,
      })
    }
  }

  if (kg && (hg === 0 || ag === 0)) {
    const yok = (kg.o || []).find((o) => /Yok/i.test(o.n))
    if (yok && yok.od >= 1.15 && yok.od <= 2.2 && min >= 50) {
      tips.push({
        kind: 'KG',
        pick: 'KG Yok',
        odds: yok.od,
        priority: 81,
        text: `Eşitlik + tek/hiç gol yokken KG Yok, erken MS X’ten daha az kırılgan (U21’de özellikle).`,
      })
    }
  }

  if (isYouthMatch(m) && min < 80 && hg === ag) {
    tips.push({
      kind: 'STRATEJİ',
      priority: 88,
      text: `U21/gençlik ${min}' ${m.score}: MS X önerme — 2. yarı açılımı yüksek. Alt / KG Yok veya 85' hâlâ eşitse X.`,
    })
  }

  return tips
}

export function listLessons() {
  return loadLessons()
}
