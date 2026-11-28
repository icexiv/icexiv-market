// 行内 P25~P75 图的几何计算：挂单与成交共用。
// 横向只覆盖各自的 P25~P75，纵向厚度表示该价位的件数，整块连续。

export const PROFILE_HEIGHT = 16
export const PROFILE_BINS = 16
export const PROFILE_CENTER = PROFILE_HEIGHT / 2
// 空桶也留一点厚度，保证整块不被拆开
export const PROFILE_MIN_HALF = 0.4

export type PricePoint = { price: number; quantity: number }

// 只统计落在 [loPct, hiPct] 内的点；区间外的一律不画。
// 桶数由调用方按区间实际像素宽度决定：窄区间用更少的桶，避免细线挤成噪点。
export function rangeBins(
  points: PricePoint[],
  loPct: number,
  hiPct: number,
  toPct: (v: number) => number,
  binCount: number = PROFILE_BINS,
): number[] {
  const count = Math.max(1, Math.floor(binCount))
  const bins = new Array<number>(count).fill(0)
  const span = Math.max(hiPct - loPct, 0.5)
  for (const point of points) {
    const pct = toPct(point.price)
    if (pct < loPct || pct > hiPct) continue
    const index = Math.min(count - 1, Math.max(0, Math.floor(((pct - loPct) / span) * count)))
    bins[index] += point.quantity
  }
  return bins
}

// 单块轮廓：从 loPct 到 hiPct 连续。
// side='both' 上下镜像；'up' 只向上长；'down' 只向下长（统计卡的成交/挂单分居上下）
export function profilePath(
  bins: number[],
  loPct: number,
  hiPct: number,
  amplitude: number,
  side: 'both' | 'up' | 'down' = 'both',
): string {
  const max = Math.max(...bins, 0)
  const top = PROFILE_CENTER * amplitude
  const half = (v: number) =>
    max > 0 ? PROFILE_MIN_HALF + (top - PROFILE_MIN_HALF) * Math.sqrt(v / max) : PROFILE_MIN_HALF
  const span = Math.max(hiPct - loPct, 0.5)
  const count = bins.length
  const step = span / count
  const xs: number[] = [loPct]
  for (let i = 0; i < count; i++) xs.push(loPct + (i + 0.5) * step)
  xs.push(hiPct)
  const hs: number[] = [half(bins[0])]
  for (let i = 0; i < count; i++) hs.push(half(bins[i]))
  hs.push(half(bins[count - 1]))
  const topAt = (i: number) => (side === 'down' ? PROFILE_CENTER : PROFILE_CENTER - hs[i])
  const bottomAt = (i: number) => (side === 'up' ? PROFILE_CENTER : PROFILE_CENTER + hs[i])
  let path = ''
  for (let i = 0; i < xs.length; i++) {
    path += `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(2)} ${topAt(i).toFixed(2)} `
  }
  for (let i = xs.length - 1; i >= 0; i--) {
    path += `L${xs[i].toFixed(2)} ${bottomAt(i).toFixed(2)} `
  }
  return path + 'Z'
}

/** 波形在某个横向位置的高度（半幅，像素）；落在区间外返回 0。 */
export function profileHalfAt(
  bins: number[],
  loPct: number,
  hiPct: number,
  atPct: number,
  amplitude: number,
): number {
  const max = Math.max(...bins, 0)
  if (max <= 0 || atPct < loPct || atPct > hiPct) return 0
  const span = Math.max(hiPct - loPct, 0.5)
  const index = Math.min(bins.length - 1, Math.max(0, Math.floor(((atPct - loPct) / span) * bins.length)))
  const top = PROFILE_CENTER * amplitude
  return PROFILE_MIN_HALF + (top - PROFILE_MIN_HALF) * Math.sqrt(bins[index] / max)
}
