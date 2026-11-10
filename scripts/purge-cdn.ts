export const CDN_ORIGIN = 'https://market.icexiv.top'
/** HTML entry points; hashed assets and item JSON are content-addressed and stay cached. */
export const PURGE_PATHS = ['/', '/index.html'] as const

export interface PurgeTask {
  url: string
  status: string
  code: number
  task_id?: string
}

export function purgeUrls(origin = CDN_ORIGIN, paths: readonly string[] = PURGE_PATHS): string[] {
  return paths.map((path) => new URL(path, origin).href)
}

/**
 * Purge the CDN copy of the site shell. A deploy replaces hashed assets, so a
 * stale shell can reference files that no longer exist.
 */
export async function purgeCdn(
  token: string | undefined,
  options: {
    origin?: string
    paths?: readonly string[]
    request?: typeof fetch
    log?: (message: string) => void
  } = {},
): Promise<PurgeTask[] | null> {
  const { origin = CDN_ORIGIN, paths = PURGE_PATHS, request = fetch, log = console.log } = options
  if (!token) {
    log('[CDN] UPYUN_TOKEN is not set; skipped cache purge')
    return null
  }

  const urls = purgeUrls(origin, paths)
  const response = await request('https://api.upyun.com/purge', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ urls: urls.join('\n') }).toString(),
    signal: AbortSignal.timeout(20_000),
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`CDN purge failed: HTTP ${response.status} ${text}`)

  const tasks = (JSON.parse(text) as { result?: PurgeTask[] }).result
  if (!Array.isArray(tasks) || !tasks.length) throw new Error(`CDN purge returned no tasks: ${text}`)
  const rejected = tasks.filter((task) => task.code !== 1)
  if (rejected.length) {
    throw new Error(`CDN purge rejected: ${rejected.map((task) => `${task.url} ${task.status} (${task.code})`).join('; ')}`)
  }

  log(`[CDN] Purged ${tasks.length} URL(s): ${urls.join(', ')}`)
  return tasks
}

if (import.meta.main) {
  await purgeCdn(process.env.UPYUN_TOKEN)
}
