import { useEffect, useMemo, useState } from 'react'

type SeriesPlan = {
  startBank: number
  unitStake: number
  parallel: number
  targetOdds: number
  roundsPlanned: number
  poolSize: number
  disclaimer: string
  howTo: string
  calendar: {
    dateKey: string
    dayLabel: string
    plays: {
      step: number
      branch: string
      time: string
      match: string
      pick: string
      odds: number
    }[]
  }[]
  steps: {
    step: number
    bankBefore: number
    parallel: number
    stakeEach: number
    stakeTotal: number
    note: string
    projection: { ifOneWins: number; ifAllWin: number }
    coupons: {
      label: string
      totalOdds: number
      estReturn: number
      windowLabel: string
      riskNote: string
      copyText: string
      targetMet: boolean
      legs: {
        dayLabel: string
        time: string
        home: string
        away: string
        pick: string
        market: string
        odds: number
        probability: number
        misliUrl: string
      }[]
    }[]
  }[]
}

function readParams() {
  const q = new URLSearchParams(window.location.search)
  return {
    startBank: Number(q.get('bank')) || 50,
    parallel: Number(q.get('parallel')) || 2,
    rounds: Number(q.get('rounds')) || 6,
    targetOdds: Number(q.get('target')) || 2.05,
    sports: (q.get('sports') || 'all') as 'all' | 'football' | 'basketball',
  }
}

export default function SeriesPage() {
  const initial = useMemo(() => readParams(), [])
  const [startBank, setStartBank] = useState(initial.startBank)
  const [parallel, setParallel] = useState(initial.parallel)
  const [rounds, setRounds] = useState(initial.rounds)
  const [targetOdds, setTargetOdds] = useState(initial.targetOdds)
  const [sports, setSports] = useState(initial.sports)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [plan, setPlan] = useState<SeriesPlan | null>(null)
  const [copied, setCopied] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startBank,
          unitStake: startBank,
          parallel,
          rounds,
          targetOdds,
          sports,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Seri plan hazırlanamadı')
      setPlan(data.plan || null)
      if (!data.plan?.steps?.length) {
        setError('Seri için yeterli düşük riskli maç yok. Parametreleri gevşetip yeniden dene.')
      }
      const next = new URLSearchParams({
        bank: String(startBank),
        parallel: String(parallel),
        rounds: String(rounds),
        target: String(targetOdds),
        sports,
      })
      window.history.replaceState(null, '', `/seri?${next.toString()}`)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Seri plan hatası')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const copyBranch = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 2000)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="page series-page">
      <div className="glow glow-a" aria-hidden />
      <div className="glow glow-b" aria-hidden />

      <header className="series-top">
        <div>
          <p className="brand">KUPON RADAR</p>
          <h1>Seri katlama planı</h1>
          <p className="lede">
            Tam ekran plan · gün/saat takvimi · paralel risk bölünmüş kuponlar. Oranlar maç gününe kadar
            değişebilir.
          </p>
        </div>
        <a className="ghost back-link" href="/">
          ← Ana sayfa
        </a>
      </header>

      <section className="controls series-controls">
        <label className="field">
          <span>Birim (TL)</span>
          <div className="chips">
            {[25, 50, 100, 200].map((v) => (
              <button key={v} type="button" className={startBank === v ? 'on' : ''} onClick={() => setStartBank(v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Paralel kupon</span>
          <div className="chips">
            {[1, 2, 3].map((v) => (
              <button key={v} type="button" className={parallel === v ? 'on' : ''} onClick={() => setParallel(v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Adım</span>
          <div className="chips">
            {[4, 6, 8].map((v) => (
              <button key={v} type="button" className={rounds === v ? 'on' : ''} onClick={() => setRounds(v)}>
                {v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Hedef kat</span>
          <div className="chips">
            {[1.9, 2.05, 2.2].map((v) => (
              <button
                key={v}
                type="button"
                className={targetOdds === v ? 'on' : ''}
                onClick={() => setTargetOdds(v)}
              >
                ×{v}
              </button>
            ))}
          </div>
        </label>
        <label className="field">
          <span>Spor</span>
          <div className="seg">
            {(
              [
                ['all', 'Hepsi'],
                ['football', 'Futbol'],
                ['basketball', 'Basket'],
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" className={sports === k ? 'on' : ''} onClick={() => setSports(k)}>
                {label}
              </button>
            ))}
          </div>
        </label>
        <div className="actions">
          <button type="button" className="primary series-btn" disabled={loading} onClick={() => void load()}>
            {loading ? 'Planlanıyor…' : 'Planı yenile'}
          </button>
        </div>
      </section>

      {error && <div className="banner err">{error}</div>}
      {loading && <div className="banner">Düşük riskli maçlar taranıyor, seri plan hazırlanıyor…</div>}

      {plan && !loading && (
        <section className="series-board series-board-full">
          <div className="board-head">
            <h3>
              {plan.roundsPlanned} adım hazır
            </h3>
            <p>
              Başlangıç {plan.startBank} TL · hedef ×{plan.targetOdds} · risk {plan.parallel} kupon · havuz{' '}
              {plan.poolSize}
            </p>
          </div>
          <p className="series-how">{plan.howTo}</p>
          <p className="series-disc">{plan.disclaimer}</p>

          {plan.calendar?.length > 0 && (
            <div className="series-calendar">
              <p className="eyebrow">Takvim — hangi gün / saat</p>
              {plan.calendar.map((day) => (
                <div key={day.dateKey} className="cal-day">
                  <strong>{day.dayLabel}</strong>
                  <ul>
                    {day.plays.map((p, i) => (
                      <li key={`${day.dateKey}-${i}`}>
                        <span className="cal-time">{p.time}</span>
                        <span>
                          Adım {p.step}/{p.branch} · {p.match}
                        </span>
                        <em>
                          {p.pick} @{p.odds}
                        </em>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )}

          <div className="series-steps">
            {plan.steps.map((st) => (
              <article key={st.step} className="series-step">
                <header>
                  <h4>
                    Adım {st.step}{' '}
                    <span>
                      banka {st.bankBefore} TL → {st.parallel}×{st.stakeEach} TL
                    </span>
                  </h4>
                  <p>{st.note}</p>
                  <p className="hint">
                    Biri tutarsa ~{st.projection.ifOneWins} TL · hepsi tutarsa ~{st.projection.ifAllWin} TL
                  </p>
                </header>
                <div className="series-coupons">
                  {st.coupons.map((c) => (
                    <div key={c.label} className="series-coupon">
                      <div className="sc-head">
                        <strong>Kupon {c.label}</strong>
                        <em>@{c.totalOdds.toFixed(2)}</em>
                        <span>→ {c.estReturn} TL</span>
                      </div>
                      <p className="sub">{c.windowLabel}</p>
                      <p className="hint">{c.riskNote}</p>
                      <ol>
                        {c.legs.map((l, i) => (
                          <li key={`${c.label}-${i}`}>
                            <span>
                              {l.dayLabel} {l.time}
                            </span>
                            <p className="match">
                              {l.home} <span>vs</span> {l.away}
                            </p>
                            <p className="sub">
                              {l.pick} · {l.market} @{l.odds} · ~%{l.probability}
                            </p>
                            <a href={l.misliUrl} target="_blank" rel="noreferrer">
                              Misli
                            </a>
                          </li>
                        ))}
                      </ol>
                      <button type="button" className="ghost" onClick={() => void copyBranch(c.copyText)}>
                        {copied ? 'Kopyalandı' : `Kupon ${c.label} kopyala`}
                      </button>
                    </div>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
