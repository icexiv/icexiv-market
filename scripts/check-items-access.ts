import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import { getItemsSource } from './prepare-items'

export const DEFAULT_ITEMS_ORIGIN = 'https://market.icexiv.top'

export async function checkItemsAccess(
  source: Pick<ReturnType<typeof getItemsSource>, 'url' | 'sha256' | 'size'>,
  origin = DEFAULT_ITEMS_ORIGIN,
  download: typeof fetch = fetch,
) {
  const response = await download(source.url, {
    headers: { Origin: origin },
    signal: AbortSignal.timeout(20_000),
  })
  if (!response.ok) throw new Error(`Public item data request failed: HTTP ${response.status}`)
  const allowedOrigin = response.headers.get('access-control-allow-origin')
  if (allowedOrigin !== '*' && allowedOrigin !== origin) {
    throw new Error(`TOS CORS does not allow ${origin} to fetch item data`)
  }
  if (!response.headers.get('content-type')?.includes('application/json')) {
    throw new Error('TOS item data must be served as application/json')
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.length !== source.size || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
    throw new Error('Public item data does not match its Shadow ref')
  }
  const items = JSON.parse(bytes.toString())
  if (!items || typeof items !== 'object' || !Object.values(items).some((item: any) => typeof item?.name === 'string')) {
    throw new Error('Public item data has no item names')
  }
  return Object.keys(items).length
}

if (import.meta.main) {
  const source = getItemsSource(resolve(import.meta.dir, '..'))
  const count = await checkItemsAccess(source, process.env.ITEMS_ORIGIN || DEFAULT_ITEMS_ORIGIN)
  console.log('[Items] Public JSON, CORS and SHA-256 verified (%d items)', count)
}
