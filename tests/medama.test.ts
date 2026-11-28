import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { YAML } from 'bun'
import { medamaAnalytics } from '../app/analytics'

const source = readFileSync(new URL('../ops/medama/tracker.js', import.meta.url), 'utf8')

test('Medama backend has no plaintext LAN or public interface binding', () => {
  const compose = YAML.parse(readFileSync(new URL('../ops/medama/compose.yaml', import.meta.url), 'utf8')) as any
  assert.deepEqual(compose.services.medama.ports, ['127.0.0.1:18180:8080', '100.119.68.25:18180:8080'])
})

test('private Caddy serves HTTPS on private IPs without weakening session cookies', () => {
  const config = readFileSync(new URL('../ops/medama/private-https.caddy', import.meta.url), 'utf8')
  assert.match(config, /https:\/\/192\.168\.2\.11:18181, https:\/\/100\.119\.68\.25:18181/)
  assert.match(config, /bind 192\.168\.2\.11 100\.119\.68\.25/)
  assert.match(config, /tls internal/)
  assert.match(config, /reverse_proxy http:\/\/127\.0\.0\.1:18180/)
  assert.doesNotMatch(config, /header_down|tls_insecure_skip_verify|0\.0\.0\.0/)
})

function browser(url = 'https://market.icexiv.top/#/', settings: Record<string, unknown> = {}) {
  const events = new Map<string, Function[]>()
  const documentEvents = new Map<string, Function[]>()
  const requests: { url: string; options: any; payload?: any }[] = []
  const location = new URL(url)
  let now = 0
  let id = 0
  let unavailable = false
  const cache = new Set<string>()
  const document = {
    hidden: false, referrer: 'https://search.example/private?q=secret#private',
    addEventListener: (type: string, fn: Function) => {
      documentEvents.set(type, [...(documentEvents.get(type) || []), fn])
    },
  }
  const context = {
    location, document, window: {},
    navigator: { doNotTrack: '0', ...settings },
    crypto: { randomUUID: () => `beacon-${++id}` },
    performance: { now: () => now },
    URL, Intl, AbortSignal,
    history: {
      pushState(_state: any, _title: string, next: string) { location.href = new URL(next, location).href },
      replaceState(_state: any, _title: string, next: string) { location.href = new URL(next, location).href },
    },
    addEventListener: (type: string, fn: Function) => { events.set(type, [...(events.get(type) || []), fn]) },
    fetch: async (url: string, options: any) => {
      requests.push({ url, options, payload: options.body && JSON.parse(options.body) })
      if (unavailable) throw new Error('offline')
      const repeat = cache.has(url)
      cache.add(url)
      return { ok: true, text: async () => repeat ? '1' : '0' }
    },
  }
  function emit(type: string, event: any = {}) {
    for (const fn of [...(events.get(type) || []), ...(documentEvents.get(type) || [])]) fn(event)
  }
  function run() { runInNewContext(source, context) }
  run()
  return {
    requests, location, context, emit, run,
    tick: (ms: number) => { now += ms },
    offline: () => { unavailable = true },
    hide: () => { document.hidden = true; emit('visibilitychange') },
    show: () => { document.hidden = false; emit('visibilitychange') },
    route: (hash: string) => { location.hash = hash; emit('hashchange') },
    views: () => requests.filter(r => r.payload?.e === 'load').map(r => r.payload),
    durations: () => requests.filter(r => r.payload?.e === 'unload').map(r => r.payload),
  }
}

const settled = () => new Promise<void>(resolve => setImmediate(resolve))

test('Medama tracks hash routes without search parameters or referrer paths', async () => {
  const b = browser('https://market.icexiv.top/?secret=a#/item/123?scope=secret&quality=hq')
  await settled()
  assert.equal(b.views().length, 1)
  assert.equal(b.views()[0].u, 'https://market.icexiv.top/item/123')
  assert.equal(b.views()[0].r, 'https://search.example/')
  assert.ok(b.requests.every(r => !r.url.includes('secret')))
  assert.ok(b.requests.every(r => r.options.credentials === 'omit' && r.options.referrerPolicy === 'no-referrer'))
})

test('each route gets a separate beacon, while quality/scope changes are not pageviews', async () => {
  const b = browser()
  await settled()
  b.tick(120)
  b.route('/item/123?scope=a')
  b.route('/item/123?scope=b&quality=nq')
  b.emit('popstate')
  await settled()
  assert.equal(b.views().length, 2)
  assert.notEqual(b.views()[0].b, b.views()[1].b)
  assert.equal(b.views()[0].p, true)
  assert.equal(b.views()[1].p, false)
  assert.equal(b.durations()[0].b, b.views()[0].b)
  assert.equal(b.durations()[0].m, 120)
})

test('rapid navigation before pings finish retains route snapshots and durations', async () => {
  const b = browser()
  b.tick(30)
  b.route('/item/123')
  b.tick(45)
  b.route('/materia')
  await settled()
  assert.deepEqual(b.views().map(v => v.u), [
    'https://market.icexiv.top/', 'https://market.icexiv.top/item/123', 'https://market.icexiv.top/materia',
  ])
  assert.equal(new Set(b.views().map(v => v.b)).size, 3)
  assert.deepEqual(b.durations().map(v => v.m), [30, 45])
})

test('returning to a page is not a new unique visitor or unique page', async () => {
  const b = browser()
  await settled()
  b.route('/materia')
  b.route('/')
  await settled()
  assert.deepEqual(b.views().map(v => [v.p, v.q]), [[true, true], [false, true], [false, false]])
})

test('visibility timing excludes hidden time without creating another pageview', async () => {
  const b = browser()
  await settled()
  b.tick(100)
  b.hide()
  b.tick(900)
  b.show()
  b.tick(50)
  b.emit('pagehide')
  await settled()
  assert.equal(b.views().length, 1)
  assert.deepEqual(b.durations().map(v => v.m), [100, 150])
})

test('history hash navigation and BFCache restore are tracked without double counting', async () => {
  const b = browser()
  await settled()
  b.context.history.pushState({}, '', '#/settings')
  b.emit('hashchange')
  await settled()
  assert.equal(b.views().length, 2)
  b.emit('pagehide')
  b.emit('pageshow', { persisted: true })
  await settled()
  assert.equal(b.views().length, 3)
  assert.equal(b.views()[2].p, false)
})

test('unknown routes are grouped without leaking arbitrary path text', async () => {
  const b = browser('https://market.icexiv.top/#/secret-personal-search?private=yes')
  await settled()
  assert.equal(b.views()[0].u, 'https://market.icexiv.top/other')
})

test('development, international sites, screenshots and privacy opt-outs send nothing', async () => {
  for (const url of ['http://localhost:5173/#/', 'https://icexiv.github.io/icexiv-market/#/',
    'https://market.icexiv.top/render.html', 'http://market.icexiv.top/']) {
    const b = browser(url)
    await settled()
    assert.equal(b.requests.length, 0, url)
  }
  for (const settings of [{ doNotTrack: '1' }, { globalPrivacyControl: true }]) {
    const b = browser(undefined, settings)
    await settled()
    assert.equal(b.requests.length, 0)
  }
})

test('duplicate installation does not send duplicate pageviews', async () => {
  const b = browser()
  b.run()
  await settled()
  assert.equal(b.views().length, 1)
})

test('collector failure stops collection without breaking navigation', async () => {
  const b = browser()
  await settled()
  b.offline()
  b.route('/materia')
  await settled()
  const count = b.requests.length
  assert.doesNotThrow(() => b.route('/settings'))
  await settled()
  assert.equal(b.requests.length, count)
})

test('only domestic production builds emit/inject the tracker, never render.html', () => {
  for (const [target, mode, enabled] of [['cn', 'production', true], ['global', 'production', false], ['cn', 'development', false]] as const) {
    const plugin = medamaAnalytics(target, mode)
    assert.equal(plugin.apply, 'build')
    const transform = plugin.transformIndexHtml as Function
    assert.equal(!!transform('', { filename: '/project/app/index.html' }), enabled)
    assert.equal(transform('', { filename: '/project/app/render.html' }), undefined)
    const emitted: any[] = []
    ;(plugin.generateBundle as Function).call({ emitFile: (file: any) => emitted.push(file) })
    assert.equal(emitted.length, enabled ? 1 : 0)
  }
})
