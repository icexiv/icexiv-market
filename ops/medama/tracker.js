// HashRouter adapter for Medama v0.6.2. No cookies or persistent identifiers.
(() => {
  if (location.protocol !== 'https:' || location.hostname !== 'market.icexiv.top'
    || !['/', '/index.html'].includes(location.pathname)
    || navigator.doNotTrack === '1' || navigator.globalPrivacyControl === true
    || window.__xivMarketAnalytics) return
  window.__xivMarketAnalytics = true

  const api = '/_analytics/api/event/'
  const options = { credentials: 'omit', referrerPolicy: 'no-referrer' }
  let disabled = false
  let claimedVisitor = false
  let current
  let queue = Promise.resolve()
  const seen = new Set()

  function route() {
    const path = (location.hash.slice(1).split(/[?#]/)[0] || '/').replace(/\/+$/, '') || '/'
    // Only known routes are sent; never send arbitrary search text in a path.
    return /^\/(?:materia|settings|debug|item\/[1-9]\d*)?$/.test(path) ? path : '/other'
  }

  function referrer() {
    try {
      const url = new URL(document.referrer)
      return /^https?:$/.test(url.protocol) ? url.origin + '/' : ''
    } catch { return '' }
  }

  async function ping(suffix = '') {
    const response = await fetch(api + 'ping' + suffix, {
      ...options, signal: AbortSignal.timeout(3000),
    })
    if (!response.ok) throw new Error('collector unavailable')
    return (await response.text()).trim() === '0'
  }

  // Start once per document; Medama uses the HTTP cache to estimate daily visitors.
  const visitor = ping().catch(() => { disabled = true; return false })

  function pause(view) {
    if (view?.visibleSince != null) {
      view.duration += performance.now() - view.visibleSince
      view.visibleSince = null
    }
  }

  function duration(view) {
    const ms = Math.min(2147483647, Math.round(view.duration))
    if (!view.loaded || ms <= view.sentDuration || ms < 1) return
    const body = JSON.stringify({ b: view.id, e: 'unload', m: ms })
    try {
      // credentialless fetch avoids forwarding unrelated same-origin cookies.
      void fetch(api + 'hit', {
        ...options, method: 'POST', body, keepalive: true,
        signal: AbortSignal.timeout(3000),
      }).catch(() => {})
      view.sentDuration = ms
    } catch { /* Analytics must never affect the application. */ }
  }

  function navigate(force = false) {
    const path = route()
    if (!force && current?.path === path) return
    const previous = current
    pause(previous)
    if (previous) duration(previous)
    const view = {
      path, id: crypto.randomUUID(), url: location.origin + path,
      referrer: previous?.url || referrer(),
      duration: 0, visibleSince: document.hidden ? null : performance.now(),
      loaded: false, sentDuration: 0,
    }
    current = view
    queue = queue.then(async () => {
      const unique = await visitor
      if (disabled) return
      const first = await ping('?u=' + encodeURIComponent(location.hostname + view.path))
      const response = await fetch(api + 'hit', {
        ...options, method: 'POST', keepalive: true, signal: AbortSignal.timeout(3000),
        body: JSON.stringify({
          b: view.id, e: 'load', u: view.url, r: view.referrer,
          p: unique && !claimedVisitor, q: first && !seen.has(view.path),
          t: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      })
      if (!response.ok) throw new Error('collector unavailable')
      claimedVisitor = true
      seen.add(view.path)
      view.loaded = true
      // A route can close while its ping/load is in flight. Keep its own ID/timer.
      if (view.visibleSince == null) duration(view)
    }).catch(() => { disabled = true })
  }

  addEventListener('hashchange', () => navigate())
  addEventListener('popstate', () => navigate())
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method]
    history[method] = function (...args) {
      const result = original.apply(this, args)
      navigate()
      return result
    }
  }
  document.addEventListener('visibilitychange', () => {
    if (!current) return
    if (document.hidden) {
      pause(current)
      duration(current)
    } else if (current.visibleSince == null) {
      current.visibleSince = performance.now()
    }
  })
  addEventListener('pagehide', () => { pause(current); if (current) duration(current) })
  addEventListener('pageshow', (event) => { if (event.persisted) navigate(true) })
  navigate()
})()
