import { useEffect, useMemo, useRef, useState } from 'react'

type MatchRow = {
  eventId: number
  sport: string
  league: string
  home: string
  away: string
  kickoffLocal?: string
  kickoff: string
  dateKey?: string
  live?: boolean
  marketCount?: number
  pick: {
    shortPick: string
    marketName: string
    outcomeName: string
    odds: number
    probability: number
    marketKind: string
    playPct?: number
  }
  analysis: string
  score: number
}

const KIND_TR: Record<string, string> = {
  ms: 'Maç Sonucu',
  cs: 'Çifte Şans',
  ou25: 'Alt/Üst 2.5',
  ou: 'Alt/Üst',
  kg: 'Karşılıklı Gol',
  ah: 'Handikap',
  iy: 'İlk Yarı',
  iy_ms: 'İY/MS',
  ms_kg: 'MS + KG',
  ms_ou: 'MS + A/Ü',
  odd_even: 'Tek/Çift',
  other: 'Diğer',
}

type LiveTip = {
  kind: string
  pick?: string
  odds?: number | null
  priority?: number
  text: string
}

type LiveMatch = {
  eventId: number
  sport: string
  league: string
  home: string
  away: string
  score: string
  minute: number | null
  periodLabel: string
  homeGoals: number
  awayGoals: number
  misliUrl: string
  tips?: LiveTip[]
}

type LiveAlert = {
  type: string
  title: string
  message: string
  eventId: number
  score: string
  at: string
  misliUrl?: string
}

type SlipLeg = {
  id: string
  eventId: number
  sport: string
  league: string
  home: string
  away: string
  score?: string
  minute?: number | null
  periodLabel?: string
  pick: string
  market: string
  odds: number
  note?: string
  misliUrl: string
  source: 'live' | 'pre'
}

export default function App() {
  const [minOdds, setMinOdds] = useState(1.35)
  const [minTotalOdds, setMinTotalOdds] = useState(5)
  const [matchCount, setMatchCount] = useState(4)
  const [sports, setSports] = useState<'all' | 'football' | 'basketball'>('all')
  const [bootLoading, setBootLoading] = useState(true)
  const [couponLoading, setCouponLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [matches, setMatches] = useState<MatchRow[]>([])
  const [source, setSource] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [bulletinCount, setBulletinCount] = useState(0)
  const [liveMatches, setLiveMatches] = useState<LiveMatch[]>([])
  const [liveAlerts, setLiveAlerts] = useState<LiveAlert[]>([])
  const [toast, setToast] = useState<LiveAlert | null>(null)
  const [slip, setSlip] = useState<SlipLeg[]>([])
  const [copied, setCopied] = useState(false)
  const [slipMsg, setSlipMsg] = useState<string | null>(null)
  const [couponNote, setCouponNote] = useState<string | null>(null)
  const [startBank, setStartBank] = useState(50)
  const [seriesParallel, setSeriesParallel] = useState(2)
  const [seriesRounds, setSeriesRounds] = useState(6)
  const [seriesTarget, setSeriesTarget] = useState(2.05)
  const toastTimer = useRef<number | null>(null)

  const slipTotal = useMemo(
    () => slip.reduce((p, leg) => p * leg.odds, 1),
    [slip],
  )

  const formatSlipText = () => {
    const lines = [
      `KUPON RADAR · Canlı/manuel kupon`,
      `${slip.length} seçim · Toplam oran ${slipTotal.toFixed(2)}`,
      minOdds ? `Maç başı min ≥${minOdds}` : null,
      minTotalOdds > 1 ? `Toplam min ≥${minTotalOdds}` : null,
      '',
      ...slip.map(
        (leg, i) =>
          `${i + 1}) ${leg.home} vs ${leg.away}` +
          (leg.score ? ` [${leg.score}]` : '') +
          `\n   ${leg.league}` +
          (leg.periodLabel ? ` · ${leg.periodLabel}${leg.minute != null ? ` ${leg.minute}'` : ''}` : '') +
          `\n   ${leg.pick} | ${leg.market} @${leg.odds.toFixed(2)}` +
          `\n   ${leg.misliUrl}`,
      ),
      '',
      `Toplam: ${slipTotal.toFixed(2)}`,
    ]
    return lines.filter((x) => x != null).join('\n')
  }

  const copySlip = async () => {
    if (!slip.length) return
    const text = formatSlipText()
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      const ta = document.createElement('textarea')
      ta.value = text
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      document.body.removeChild(ta)
    }
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const addToSlip = (leg: Omit<SlipLeg, 'id'>) => {
    if (leg.odds < minOdds) {
      setSlipMsg(`Maç başı min oran ${minOdds} — bu seçim @${leg.odds.toFixed(2)}`)
      window.setTimeout(() => setSlipMsg(null), 2500)
      return
    }
    setSlip((prev) => {
      if (prev.some((x) => x.eventId === leg.eventId && x.pick === leg.pick)) {
        setSlipMsg('Bu seçim zaten kuponda')
        window.setTimeout(() => setSlipMsg(null), 2000)
        return prev
      }
      if (prev.some((x) => x.eventId === leg.eventId)) {
        // replace same match with new market
        return [...prev.filter((x) => x.eventId !== leg.eventId), { ...leg, id: `${leg.eventId}-${leg.pick}-${Date.now()}` }]
      }
      return [...prev, { ...leg, id: `${leg.eventId}-${leg.pick}-${Date.now()}` }]
    })
  }

  const removeFromSlip = (id: string) => {
    setSlip((prev) => prev.filter((x) => x.id !== id))
  }

  const clearSlip = () => {
    setSlip([])
    setCouponNote(null)
  }

  const openSeriesPage = () => {
    const q = new URLSearchParams({
      bank: String(startBank),
      parallel: String(seriesParallel),
      rounds: String(seriesRounds),
      target: String(seriesTarget),
      sports,
    })
    window.open(`/seri?${q.toString()}`, '_blank', 'noopener,noreferrer')
  }

  const prepareCoupon = async () => {
    setCouponLoading(true)
    setError(null)
    setSlipMsg(null)
    try {
      const res = await fetch('/api/coupon', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchCount,
          minOdds,
          minTotalOdds,
          sports,
          marketFocus: 'all',
          dateMode: 'all',
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Kupon hazırlanamadı')
      const coupon = data.coupon
      const legs = coupon?.legs || []
      if (!legs.length) {
        setSlip([])
        setCouponNote(coupon?.note || 'Uygun yaklaşan maç bulunamadı. Min oranı düşür veya havuzu yenile.')
        setSlipMsg('Kupon boş — yaklaşan maç / oran filtresi')
        window.setTimeout(() => setSlipMsg(null), 3500)
        return
      }
      setSlip(
        legs.map((leg: {
          eventId: number
          sport: string
          league: string
          home: string
          away: string
          pick: string
          market: string
          odds: number
          analysis?: string
          misliUrl: string
          kickoff?: string
        }) => ({
          id: `auto-${leg.eventId}-${leg.pick}`,
          eventId: leg.eventId,
          sport: leg.sport,
          league: leg.league,
          home: leg.home,
          away: leg.away,
          periodLabel: leg.kickoff,
          pick: leg.pick,
          market: leg.market,
          odds: leg.odds,
          note: leg.analysis,
          misliUrl: leg.misliUrl,
          source: 'pre' as const,
        })),
      )
      setCouponNote(coupon?.note || null)
      const tot = Number(coupon?.totalOdds || 0)
      if (coupon?.totalTargetMet === false && minTotalOdds > 1) {
        setSlipMsg(`Toplam ${tot.toFixed(2)} — hedef ≥${minTotalOdds} tutmadı`)
      } else {
        setSlipMsg(`${legs.length} seçim · toplam ${tot.toFixed(2)} (≥${minTotalOdds})`)
      }
      window.setTimeout(() => setSlipMsg(null), 3500)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Kupon hatası')
    } finally {
      setCouponLoading(false)
    }
  }

  const pushToast = (alert: LiveAlert) => {
    setToast(alert)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 6500)
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      try {
        new Notification(alert.title, { body: alert.message })
      } catch {
        /* ignore */
      }
    }
  }

  const loadMatches = async () => {
    setBootLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/matches')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Misli oranları alınamadı')
      setMatches(data.matches || [])
      setSource(data.source || 'Misli.com')
      setUpdatedAt(data.updatedAt)
      setBulletinCount(data.bulletinCount || 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Bağlantı hatası')
    } finally {
      setBootLoading(false)
    }
  }

  useEffect(() => {
    void loadMatches()
  }, [])

  useEffect(() => {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission()
    }
    const es = new EventSource('/api/live/stream')
    es.addEventListener('snapshot', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        setLiveMatches(data.matches || [])
        setLiveAlerts(data.alerts || [])
      } catch {
        /* ignore */
      }
    })
    es.addEventListener('tick', (ev) => {
      try {
        const data = JSON.parse((ev as MessageEvent).data)
        setLiveMatches(data.matches || [])
        if (data.alerts) setLiveAlerts(data.alerts)
      } catch {
        /* ignore */
      }
    })
    es.addEventListener('alert', (ev) => {
      try {
        const alert = JSON.parse((ev as MessageEvent).data) as LiveAlert
        setLiveAlerts((prev) => [alert, ...prev].slice(0, 40))
        pushToast(alert)
      } catch {
        /* ignore */
      }
    })
    return () => {
      es.close()
      if (toastTimer.current) window.clearTimeout(toastTimer.current)
    }
  }, [])

  const sportLabel = useMemo(
    () => ({ all: 'Futbol + Basket', football: 'Sadece Futbol', basketball: 'Sadece Basket' })[sports],
    [sports],
  )

  const visibleMatches = useMemo(() => {
    return matches.filter((m) => {
      if (sports === 'football' && m.sport !== 'football') return false
      if (sports === 'basketball' && m.sport !== 'basketball') return false
      return true
    })
  }, [matches, sports])

  const filteredLive = useMemo(() => {
    const rows = liveMatches.filter((m) => {
      if (sports === 'football' && m.sport !== 'football') return false
      if (sports === 'basketball' && m.sport !== 'basketball') return false
      return true
    })
    const playable = (m: LiveMatch) =>
      (m.tips || []).filter(
        (t) => t.kind !== 'DURUM' && t.kind !== 'STRATEJİ' && t.pick && t.odds != null && Number(t.odds) >= minOdds,
      )
    const hit = (t: LiveTip) => {
      const implied = t.odds ? Math.min(0.92, 1 / Number(t.odds)) : 0
      return implied * 100 + (t.priority || 0) * 0.15
    }
    return [...rows].sort((a, b) => {
      const ba = playable(a)
      const bb = playable(b)
      if (!ba.length && !bb.length) return 0
      if (!ba.length) return 1
      if (!bb.length) return -1
      return Math.max(...bb.map(hit)) - Math.max(...ba.map(hit))
    })
  }, [liveMatches, sports, minOdds])

  return (
    <div className="page">
      <div className="glow glow-a" aria-hidden />
      <div className="glow glow-b" aria-hidden />
      <div className="pitch" aria-hidden />

      <header className="hero">
        <div className="hero-top">
          <p className="brand">KUPON RADAR</p>
          <h1>Canlı öneri ve kupon</h1>
        </div>
        <div className="hero-meta">
          <span>{new Date().toLocaleDateString('tr-TR', { weekday: 'short', day: 'numeric', month: 'short' })}</span>
          <span>Misli</span>
          {updatedAt && <span>{new Date(updatedAt).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}</span>}
        </div>
      </header>

      <section className="controls">
        <label className="field span-2">
          <span>Min oran</span>
          <div className="row">
            <input
              type="number"
              min={1.01}
              max={5}
              step={0.05}
              value={minOdds}
              onChange={(e) => setMinOdds(Number(e.target.value))}
            />
            <div className="chips">
              {[1.2, 1.35, 1.5, 1.7, 2.0].map((v) => (
                <button key={v} type="button" className={minOdds === v ? 'on' : ''} onClick={() => setMinOdds(v)}>
                  {v.toFixed(2)}
                </button>
              ))}
            </div>
          </div>
        </label>

        <label className="field span-2">
          <span>Toplam oran</span>
          <div className="row">
            <input
              type="number"
              min={1}
              max={200}
              step={0.5}
              value={minTotalOdds}
              onChange={(e) => setMinTotalOdds(Number(e.target.value))}
            />
            <div className="chips">
              {[3, 5, 8, 12, 20].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={minTotalOdds === v ? 'on' : ''}
                  onClick={() => setMinTotalOdds(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        </label>

        <label className="field">
          <span>Maç</span>
          <div className="chips">
            {[3, 4, 5, 6, 8].map((v) => (
              <button
                key={v}
                type="button"
                className={matchCount === v ? 'on' : ''}
                onClick={() => setMatchCount(v)}
              >
                {v}
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

        <label className="field">
          <span>Birim ₺</span>
          <div className="chips">
            {[25, 50, 100, 200].map((v) => (
              <button
                key={v}
                type="button"
                className={startBank === v ? 'on' : ''}
                onClick={() => setStartBank(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </label>

        <label className="field">
          <span>Paralel</span>
          <div className="chips">
            {[1, 2, 3].map((v) => (
              <button
                key={v}
                type="button"
                className={seriesParallel === v ? 'on' : ''}
                onClick={() => setSeriesParallel(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </label>

        <label className="field span-2">
          <span>Adım / kat</span>
          <div className="row">
            <div className="chips">
              {[4, 6, 8].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={seriesRounds === v ? 'on' : ''}
                  onClick={() => setSeriesRounds(v)}
                >
                  {v} adım
                </button>
              ))}
            </div>
            <div className="chips">
              {[1.9, 2.05, 2.2].map((v) => (
                <button
                  key={v}
                  type="button"
                  className={seriesTarget === v ? 'on' : ''}
                  onClick={() => setSeriesTarget(v)}
                >
                  ×{v}
                </button>
              ))}
            </div>
          </div>
        </label>

        <div className="actions">
          <button
            type="button"
            className="primary"
            disabled={couponLoading || bootLoading}
            onClick={() => void prepareCoupon()}
          >
            {couponLoading ? 'Hazırlanıyor…' : 'Kupon hazırla'}
          </button>
          <button type="button" className="primary series-btn" onClick={openSeriesPage}>
            Seri katlama planı →
          </button>
          <button type="button" className="ghost" disabled={bootLoading} onClick={() => void loadMatches()}>
            Havuzu yenile
          </button>
          {slipMsg && <span className="hint">{slipMsg}</span>}
        </div>
      </section>

      {error && <div className="banner err">{error}</div>}
      {bootLoading && (
        <div className="banner">Misli bülteni + tüm marketler çekiliyor (bu 10–20 sn sürebilir)…</div>
      )}

      {toast && (
        <div className={`toast toast-${toast.type}`} role="status">
          <strong>{toast.title}</strong>
          <span>{toast.message}</span>
        </div>
      )}

      <section className="live-workspace">
        <div className="board-head">
          <h3>
            Canlı öneriler <em className="pulse">{filteredLive.length}</em>
          </h3>
          <p>Oranlı öneriye Ekle · sağda kuponunu biriktir · sonra kopyala</p>
        </div>

        <div className="workspace-grid">
          <div className="live-scores">
            {filteredLive.slice(0, 16).map((m) => {
              const tips = (m.tips || [])
                .filter((t) => t.kind !== 'DURUM' && t.pick && t.odds != null && Number(t.odds) >= minOdds)
                .sort((a, b) => {
                  const ha = (a.odds ? Math.min(0.92, 1 / Number(a.odds)) : 0) * 100 + (a.priority || 0) * 0.15
                  const hb = (b.odds ? Math.min(0.92, 1 / Number(b.odds)) : 0) * 100 + (b.priority || 0) * 0.15
                  return hb - ha
                })
              return (
                <article key={m.eventId} className="live-card">
                  <div className="live-meta">
                    <span className="badge live-b">{m.sport === 'football' ? 'FB' : 'BB'}</span>
                    <span>
                      {m.periodLabel}
                      {m.minute != null ? ` ${m.minute}'` : ''}
                    </span>
                    <a href={m.misliUrl} target="_blank" rel="noreferrer">
                      Misli
                    </a>
                  </div>
                  <p className="match">
                    {m.home} <strong className="score">{m.score}</strong> {m.away}
                  </p>
                  <p className="sub">{m.league}</p>
                  <ul className="tip-list">
                    {tips.slice(0, 5).map((t, i) => {
                      const inSlip = slip.some((s) => s.eventId === m.eventId && s.pick === t.pick)
                      return (
                        <li key={`${m.eventId}-${i}`} className="tip-row">
                          <div className="tip-main">
                            <em>{t.kind}</em>
                            <strong>
                              {t.pick} @{Number(t.odds).toFixed(2)}
                            </strong>
                            <span>{t.text}</span>
                          </div>
                          <button
                            type="button"
                            className={`add-btn ${inSlip ? 'on' : ''}`}
                            disabled={inSlip}
                            onClick={() =>
                              addToSlip({
                                eventId: m.eventId,
                                sport: m.sport,
                                league: m.league,
                                home: m.home,
                                away: m.away,
                                score: m.score,
                                minute: m.minute,
                                periodLabel: m.periodLabel,
                                pick: t.pick!,
                                market: t.kind,
                                odds: Number(t.odds),
                                note: t.text,
                                misliUrl: m.misliUrl,
                                source: 'live',
                              })
                            }
                          >
                            {inSlip ? 'Eklendi' : 'Ekle'}
                          </button>
                        </li>
                      )
                    })}
                    {!tips.length && (
                      <li className="empty">Bu maçta eklenebilir oranlı öneri yok (min {minOdds}).</li>
                    )}
                  </ul>
                </article>
              )
            })}
            {!filteredLive.length && <p className="empty">Şu an canlı maç yok veya bağlanıyor…</p>}

            <div className="live-alerts compact-alerts">
              <p className="eyebrow">Canlı uyarılar</p>
              <ul>
                {liveAlerts.slice(0, 8).map((a, i) => (
                  <li key={`${a.eventId}-${a.at}-${i}`} className={`al-${a.type}`}>
                    <strong>{a.title}</strong>
                    <span>{a.message}</span>
                  </li>
                ))}
                {!liveAlerts.length && <li className="empty">Gol/kart olunca burada.</li>}
              </ul>
            </div>
          </div>

          <aside className="slip-panel">
            <div className="slip-head">
              <p className="eyebrow">Benim kuponum</p>
              <h3>
                {slip.length} seçim · <em>{slip.length ? slipTotal.toFixed(2) : '—'}</em>
              </h3>
              {minTotalOdds > 1 && (
                <p className={`hint ${slipTotal >= minTotalOdds ? 'ok' : ''}`}>
                  Hedef ≥{minTotalOdds} {slip.length ? (slipTotal >= minTotalOdds ? '✓' : '✗') : ''}
                </p>
              )}
              {couponNote && <p className="hint slip-note">{couponNote}</p>}
            </div>

            <ol className="slip-list">
              {slip.map((leg, i) => (
                <li key={leg.id}>
                  <div className="slip-top">
                    <span className="idx">{i + 1}</span>
                    <div>
                      <p className="match">
                        {leg.home} <span>vs</span> {leg.away}
                      </p>
                      <p className="sub">
                        {leg.score ? `${leg.score} · ` : ''}
                        {leg.periodLabel || ''}
                        {leg.minute != null ? ` ${leg.minute}'` : ''} · {leg.league}
                      </p>
                    </div>
                    <button type="button" className="remove-btn" onClick={() => removeFromSlip(leg.id)} aria-label="Çıkar">
                      ×
                    </button>
                  </div>
                  <div className="slip-pick">
                    <span>{leg.pick}</span>
                    <strong>@{leg.odds.toFixed(2)}</strong>
                  </div>
                  {leg.note && <p className="analysis compact">{leg.note}</p>}
                  <a className="slip-link" href={leg.misliUrl} target="_blank" rel="noreferrer">
                    Misli’de aç
                  </a>
                </li>
              ))}
              {!slip.length && (
                <li className="empty slip-empty">Soldan oranlı öneriye Ekle ile kuponunu doldur.</li>
              )}
            </ol>

            <div className="slip-actions">
              <button type="button" className="primary" disabled={!slip.length} onClick={() => void copySlip()}>
                {copied ? 'Kopyalandı ✓' : 'Kuponu kopyala'}
              </button>
              <button type="button" className="ghost" disabled={!slip.length} onClick={clearSlip}>
                Temizle
              </button>
            </div>
          </aside>
        </div>
      </section>

      <section className="board">
        <div className="board-head">
          <h3>Yaklaşan maç havuzu</h3>
          <p>
            {visibleMatches.length} maç · {sportLabel} · bülten {bulletinCount} · {source}
          </p>
        </div>
        <div className="table">
          {visibleMatches.slice(0, 40).map((m) => {
            const inSlip = slip.some((s) => s.eventId === m.eventId)
            return (
              <article key={m.eventId} className="row-card">
                <div className="rc-main">
                  <span className={`badge ${m.sport}`}>{m.sport === 'football' ? 'FB' : 'BB'}</span>
                  <div>
                    <p className="match">
                      {m.home} <span>vs</span> {m.away}
                    </p>
                    <p className="sub">
                      {m.league} · {m.kickoffLocal || m.kickoff}
                    </p>
                  </div>
                </div>
                <div className="rc-pick">
                  <span className="kind">{KIND_TR[m.pick.marketKind] || m.pick.marketName}</span>
                  <span>{m.pick.shortPick}</span>
                  <strong>{m.pick.odds.toFixed(2)}</strong>
                  <button
                    type="button"
                    className={`add-btn ${inSlip ? 'on' : ''}`}
                    disabled={inSlip}
                    onClick={() =>
                      addToSlip({
                        eventId: m.eventId,
                        sport: m.sport,
                        league: m.league,
                        home: m.home,
                        away: m.away,
                        pick: m.pick.shortPick,
                        market: m.pick.marketName,
                        odds: m.pick.odds,
                        note: m.analysis,
                        misliUrl: `https://www.misli.com/iddaa/${m.eventId}`,
                        source: 'pre',
                      })
                    }
                  >
                    {inSlip ? 'Eklendi' : 'Ekle'}
                  </button>
                </div>
                <p className="analysis compact">{m.analysis}</p>
              </article>
            )
          })}
          {!bootLoading && visibleMatches.length === 0 && (
            <p className="empty">Yaklaşan maç yok. Havuzu yenile.</p>
          )}
        </div>
      </section>

      <footer className="foot">
        <p>
          Oranlar Misli.com genel API uçlarından okunur. Bilgi amaçlıdır; bahis tavsiyesi değildir. 18+ ·
          Sorumlu oyun.
        </p>
      </footer>
    </div>
  )
}
