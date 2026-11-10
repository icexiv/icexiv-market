import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CDN_ORIGIN, PURGE_PATHS, purgeCdn, purgeUrls } from '../scripts/purge-cdn'

const task = { url: 'https://market.icexiv.top/', status: '刷新成功', code: 1, task_id: 't1' }

function request(token: string, body: string) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal(String(url), 'https://api.upyun.com/purge')
    assert.equal(init?.method, 'POST')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('Authorization'), `Bearer ${token}`)
    assert.equal(headers.get('Content-Type'), 'application/x-www-form-urlencoded')
    assert.equal(String(init?.body), body)
    return new Response(JSON.stringify({ result: [task] }), { status: 200 })
  }) as typeof fetch
}

test('a deploy purges the site shell of the production domain', async () => {
  assert.equal(CDN_ORIGIN, 'https://market.icexiv.top')
  assert.deepEqual(purgeUrls(), ['https://market.icexiv.top/', 'https://market.icexiv.top/index.html'])
  assert.deepEqual(purgeUrls('https://example.com/base/', ['/', '/app.html']), [
    'https://example.com/',
    'https://example.com/app.html',
  ])

  const urls = purgeUrls().join('\n')
  const tasks = await purgeCdn('secret-token', {
    request: request('secret-token', new URLSearchParams({ urls }).toString()),
    log: () => {},
  })
  assert.deepEqual(tasks, [task])
})

test('a missing token skips the purge instead of failing the deployment', async () => {
  const messages: string[] = []
  const tasks = await purgeCdn(undefined, {
    request: (() => { throw new Error('must not request') }) as unknown as typeof fetch,
    log: (message) => messages.push(message),
  })
  assert.equal(tasks, null)
  assert.match(messages.join('\n'), /UPYUN_TOKEN is not set/)
})

test('CDN rejections and HTTP errors fail the deployment', async () => {
  const rejected = (async () =>
    new Response(JSON.stringify({ result: [{ ...task, code: 4, status: '该域名不属于您' }] }), { status: 200 })) as typeof fetch
  await assert.rejects(purgeCdn('t', { request: rejected, log: () => {} }), /该域名不属于您/)

  const unauthorized = (async () => new Response('{"message":"Invalid Access Token"}', { status: 401 })) as typeof fetch
  await assert.rejects(purgeCdn('t', { request: unauthorized, log: () => {} }), /HTTP 401/)

  const empty = (async () => new Response('{}', { status: 200 })) as typeof fetch
  await assert.rejects(purgeCdn('t', { request: empty, log: () => {} }), /no tasks/)
})

test('every configured entry point is submitted at once', async () => {
  assert.deepEqual(PURGE_PATHS, ['/', '/index.html'])
})
