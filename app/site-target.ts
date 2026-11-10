export type SiteTarget = 'cn' | 'global'

export function resolveSiteTarget(value: string | undefined): SiteTarget {
  if (value === undefined) return 'global'
  if (value === 'cn' || value === 'global') return value
  throw new Error(`Invalid VITE_SITE_TARGET: ${JSON.stringify(value)}; expected cn or global`)
}
