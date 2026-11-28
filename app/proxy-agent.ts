import { Agent as HttpsAgent } from 'node:https'
import { connect as netConnect, type Socket } from 'node:net'
import { connect as tlsConnect } from 'node:tls'

/**
 * Agent for the dev-only Universalis proxy.
 *
 * The Vite dev server reaches Universalis with Node's http client, which ignores
 * `HTTPS_PROXY`; on networks that only reach the outside world through the system
 * proxy (Clash, corporate MITM) the direct connection stalls mid-response and the
 * page never leaves its skeletons. When a proxy is configured, tunnel the dev
 * server's upstream requests through it with a plain CONNECT, so dev behaves like
 * the browser. Without the env var this returns undefined and the proxy is direct,
 * exactly as before.
 */
export function createEnvProxyAgent(proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy) {
  if (!proxyUrl) return undefined
  const proxy = new URL(proxyUrl)
  if (proxy.protocol !== 'http:') return undefined
  const proxyPort = Number(proxy.port || 80)
  const proxyHost = proxy.hostname
  const authorization = proxy.username
    ? `Proxy-Authorization: Basic ${Buffer.from(
        `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`,
      ).toString('base64')}\r\n`
    : ''

  const agent = new HttpsAgent({ keepAlive: true })
  const connectThroughProxy = (
    options: { host?: string; hostname?: string; port?: number; servername?: string },
    callback: (error: Error | null, socket?: Socket) => void,
  ) => {
    const targetHost = options.host ?? options.hostname
    const targetPort = Number(options.port ?? 443)
    const raw = netConnect(proxyPort, proxyHost)
    let settled = false
    const fail = (error: Error) => {
      if (settled) return
      settled = true
      raw.destroy()
      callback(error)
    }

    raw.once('error', fail)
    raw.once('connect', () => {
      const authority = `${targetHost}:${targetPort}`
      raw.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n${authorization}\r\n`)
      let head = Buffer.alloc(0)
      const onData = (chunk: Buffer) => {
        head = Buffer.concat([head, chunk])
        const end = head.indexOf('\r\n\r\n')
        if (end < 0) return
        raw.off('data', onData)
        const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('latin1')
        if (!/^HTTP\/1\.[01] 200/.test(statusLine)) {
          fail(new Error(`Dev proxy refused CONNECT ${authority}: ${statusLine}`))
          return
        }
        // 隧道里可能已经带上了上游数据，交给 TLS 层继续读
        raw.pause()
        const rest = head.subarray(end + 4)
        if (rest.length) raw.unshift(rest)
        const secure = tlsConnect(
          { socket: raw, servername: options.servername ?? targetHost },
          () => {
            if (settled) return
            settled = true
            raw.off('error', fail)
            callback(null, secure as unknown as Socket)
          },
        )
        secure.once('error', fail)
      }
      raw.on('data', onData)
    })
  }
  agent.createConnection = connectThroughProxy as unknown as typeof agent.createConnection
  return agent
}
