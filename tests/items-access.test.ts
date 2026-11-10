import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { checkItemsAccess, DEFAULT_ITEMS_ORIGIN } from '../scripts/check-items-access'

const body = JSON.stringify({ '2': { name: '火之碎晶', icon: 20001 } })
const source = {
  url: 'https://tos.example/items.json',
  sha256: createHash('sha256').update(body).digest('hex'),
  size: Buffer.byteLength(body),
}

function download(allowedOrigin?: string, payload = body): typeof fetch {
  return (async (url, options) => {
    assert.equal(url, source.url)
    assert.equal(new Headers(options?.headers).get('Origin'), DEFAULT_ITEMS_ORIGIN)
    const headers = new Headers({ 'Content-Type': 'application/json' })
    if (allowedOrigin) headers.set('Access-Control-Allow-Origin', allowedOrigin)
    return new Response(payload, { headers })
  }) as typeof fetch
}

test('public item access checks the custom production domain', async () => {
  assert.equal(DEFAULT_ITEMS_ORIGIN, 'https://market.icexiv.top')
  assert.equal(await checkItemsAccess(source, undefined, download(DEFAULT_ITEMS_ORIGIN)), 1)
  assert.equal(await checkItemsAccess(source, undefined, download('*')), 1)
})

test('a missing or stale CORS rule fails deployment for the new domain', async () => {
  for (const allowedOrigin of [undefined, 'https://azurice.github.io']) {
    await assert.rejects(checkItemsAccess(source, undefined, download(allowedOrigin)), /CORS does not allow https:\/\/market\.icexiv\.top/)
  }
})

test('the public access probe can check another deployment origin', async () => {
  const origin = 'https://icexiv.github.io'
  const fetcher = (async (_, options) => {
    assert.equal(new Headers(options?.headers).get('Origin'), origin)
    return new Response(body, { headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin } })
  }) as typeof fetch
  assert.equal(await checkItemsAccess(source, origin, fetcher), 1)
})

test('allowed origins do not bypass content hash verification', async () => {
  await assert.rejects(checkItemsAccess(source, undefined, download(DEFAULT_ITEMS_ORIGIN, body.replace('火', '冰'))), /does not match its Shadow ref/)
})
