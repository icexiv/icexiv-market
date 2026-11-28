import { createMemo, createSignal, createEffect, Show, For, onCleanup } from 'solid-js'
import { getDcColorHex, type WorldDirectory } from '@xiv-market/shared'
import { Card, CardContent, CardHeader } from '../card'
import { Button } from '../button'
import { Root as ButtonPrimitive } from '@kobalte/core/button'
import { Skeleton } from '../skeleton'
import { EmptyState } from '../empty-state'
import { RefreshButton } from '../refresh-button'
import { Tooltip, TooltipPortal, TooltipTrigger, TooltipContent } from '../tooltip'
import { formatGil, formatAxisGil, formatDailySales, formatTime } from './format'
import { PROFILE_HEIGHT, PROFILE_CENTER, PROFILE_BINS, PROFILE_ROW_MIN_HALF, PROFILE_ROW_MAX_HALF, rangeBins, profilePath } from './profile'

type ChartConstructor = typeof import('chart.js/auto').default

let chartPromise: Promise<ChartConstructor> | null = null

async function loadChart(): Promise<ChartConstructor> {
  try {
    chartPromise ??= import('chart.js/auto').then((mod) => mod.default)
    return await chartPromise
  } catch (e) {
    // 加载失败时重置缓存的 promise，下次调用可重试
    // （否则 rejected promise 被永久复用，图表永远无法自愈）
    chartPromise = null
    throw e
  }
}

function createChartHelpers(directory: () => WorldDirectory) {
  const CHINA_DC_NAMES = ['陆行鸟', '莫古力', '猫小胖', '豆豆柴'] as const

  const FALLBACK_DC_COLOR = { solid: '#9ca3af', bg: '#9ca3af80', point: '#9ca3af80' }
  const SERVER_COLORS = [
    { solid: '#38bdf8', bg: '#38bdf880', point: '#38bdf880' },
    { solid: '#fb7185', bg: '#fb718580', point: '#fb718580' },
    { solid: '#4ade80', bg: '#4ade8080', point: '#4ade8080' },
    { solid: '#fbbf24', bg: '#fbbf2480', point: '#fbbf2480' },
    { solid: '#a78bfa', bg: '#a78bfa80', point: '#a78bfa80' },
    { solid: '#f472b6', bg: '#f472b680', point: '#f472b680' },
    { solid: '#2dd4bf', bg: '#2dd4bf80', point: '#2dd4bf80' },
    { solid: '#94a3b8', bg: '#94a3b880', point: '#94a3b880' },
  ]

  function getDcColor(dc: string | null | undefined) {
    const hex = dc ? getDcColorHex(dc) : null
    if (hex) return { solid: hex, bg: `${hex}80`, point: `${hex}80` }
    return FALLBACK_DC_COLOR
  }

  type ScopeKind = 'region' | 'dc' | 'world'

  function getScopeKind(scope: string): ScopeKind {
    if (directory().dataCenters.some((dc) => dc.region === scope)) return 'region'
    if (directory().dataCenters.some((dc) => dc.name === scope)) return 'dc'
    return 'world'
  }

  function getWorldNamesInDc(dcName: string): string[] {
    const dc = directory().dataCenters.find((d) => d.name === dcName)
    if (!dc) return []
    return dc.worlds
      .map((worldId) => directory().worldName(worldId))
      .filter((name): name is string => Boolean(name))
  }

  function getChartGroupName(scope: string, worldName: string | undefined): string {
    const kind = getScopeKind(scope)
    if (kind === 'region') return directory().dcNameByWorldName(worldName || '') || '未知'
    if (kind === 'dc') return worldName || '未知服务器'
    return worldName || scope
  }

  function getChartGroupOrder(scope: string, presentGroups: string[]): string[] {
    const present = new Set(presentGroups)
    const kind = getScopeKind(scope)

    if (kind === 'region') {
      const regionDcs = directory().dataCenters.filter((dc) => dc.region === scope).map((dc) => dc.name)
      const ordered: string[] = CHINA_DC_NAMES.filter((name) => regionDcs.includes(name) && present.has(name))
      for (const dc of regionDcs) {
        if (!ordered.includes(dc) && present.has(dc)) ordered.push(dc)
      }
      return ordered
    }

    if (kind === 'dc') {
      const ordered = getWorldNamesInDc(scope).filter((name) => present.has(name))
      for (const group of presentGroups) {
        if (!ordered.includes(group)) ordered.push(group)
      }
      return ordered
    }

    return presentGroups.slice(0, 1)
  }

  function getChartGroupColor(scope: string, groupName: string) {
    const kind = getScopeKind(scope)
    if (kind === 'region') return getDcColor(groupName)
    if (kind === 'dc') {
      const index = getWorldNamesInDc(scope).indexOf(groupName)
      return SERVER_COLORS[index >= 0 ? index % SERVER_COLORS.length : 0]
    }
    return getDcColor(directory().dcNameByWorldName(groupName))
  }

  function filterOutliers(values: number[]): number[] {
    if (values.length < 4) return values
    const sorted = [...values].sort((a, b) => a - b)
    const q1Index = Math.floor(sorted.length * 0.25)
    const q3Index = Math.floor(sorted.length * 0.75)
    const q1 = sorted[q1Index]
    const q3 = sorted[q3Index]
    const iqr = q3 - q1
    const upper = q3 + 3 * iqr
    return values.filter((v) => v <= upper)
  }

  function computeStats(
    server: string,
    listings: any[],
    shouldFilter: boolean
  ) {
    const prices = listings
      .map((l) => Number(l.pricePerUnit ?? 0))
      .filter((v) => Number.isFinite(v) && v > 0)
    const filtered = shouldFilter ? filterOutliers(prices) : prices
    if (!filtered.length) {
      return {
        server,
        dc: directory().dcNameByWorldName(server) || '未知',
        min: 0,
        max: 0,
        p25: 0,
        p75: 0,
        median: 0,
        count: 0,
        listingCount: listings.length,
        lastReviewTime: Math.max(0, ...listings.map((l) => Number(l.lastReviewTime ?? 0))) * 1000,
      }
    }
    const sorted = [...filtered].sort((a, b) => a - b)
    const min = sorted[0]
    const max = sorted[sorted.length - 1]
    const p25 = sorted[Math.floor(sorted.length * 0.25)]
    const p75 = sorted[Math.floor(sorted.length * 0.75)]
    const mid = Math.floor(sorted.length / 2)
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid]
    const lastReviewTime = Math.max(0, ...listings.map((l) => Number(l.lastReviewTime ?? 0))) * 1000
    return {
      server,
      dc: directory().dcNameByWorldName(server) || '未知',
      min,
      max,
      p25,
      p75,
      median,
      count: filtered.length,
      listingCount: listings.length,
      lastReviewTime,
    }
  }


  return { getScopeKind, getChartGroupName, getChartGroupOrder, getChartGroupColor, computeStats, filterOutliers, getDcNameByWorldName: (name: string) => directory().dcNameByWorldName(name) }
}

export function ListingTableSkeleton() {
  return (
    <div class="space-y-2" role="status">
      <span class="sr-only">加载中</span>
      <div class="grid grid-cols-[3rem_1fr_3rem_1fr_5rem_5rem] gap-4 px-3 py-2">
        <For each={Array.from({ length: 6 })}>
          {() => <Skeleton class="h-4 w-full" />}
        </For>
      </div>
      <For each={Array.from({ length: 8 })}>
        {() => (
          <div class="grid grid-cols-[3rem_1fr_3rem_1fr_5rem_5rem] gap-4 px-3 py-2">
            <Skeleton class="h-6 w-10" />
            <Skeleton class="h-5 w-24" />
            <Skeleton class="h-5 w-8" />
            <Skeleton class="h-5 w-28" />
            <Skeleton class="h-5 w-16" />
            <Skeleton class="h-5 w-16" />
          </div>
        )}
      </For>
    </div>
  )
}

export function ListingChartSkeleton() {
  return (
    <Card class="mb-6 py-3" role="status">
      <span class="sr-only">加载中</span>
      <CardHeader class="pb-2">
        <Skeleton class="h-5 w-28" />
        <Skeleton class="h-4 w-40" />
      </CardHeader>
      <CardContent class="pt-0">
        <div class="flex gap-2 mb-4">
          <Skeleton class="h-9 w-20" />
          <Skeleton class="h-9 w-24" />
        </div>
        <Skeleton class="h-[300px] w-full" />
      </CardContent>
    </Card>
  )
}

// 图表卡片区域的错误屏（无数据时错误的落点）
export function ChartErrorCard(props: { title: string; description?: string; loading: boolean; onRetry: () => void }) {
  return (
    <Card class="mb-6 py-3">
      <CardContent class="pt-0">
        <EmptyState
          variant="error"
          title={props.title}
          description={props.description}
          action={<RefreshButton loading={props.loading} onClick={props.onRetry} />}
        />
      </CardContent>
    </Card>
  )
}

// chart.js 动态 import 失败时的图内错误行（图表代码包加载失败，与数据无关）
function ChartLoadError(props: { onRetry: () => void }) {
  return (
    <div class="flex h-[240px] sm:h-[320px] w-full flex-col items-center justify-center gap-2" role="alert" data-chart-state="error">
      <p class="text-sm text-muted-foreground">图表加载失败</p>
      <Button variant="link" size="sm" class="h-auto p-0" onClick={props.onRetry}>
        重试
      </Button>
    </div>
  )
}

type SalesTrend = 'up' | 'down' | 'flat'

// 行内波形厚度：整高的 20%~50%
const ROW_LIMITS = { minHalf: PROFILE_ROW_MIN_HALF, maxHalf: PROFILE_ROW_MAX_HALF }

function computeSalesVelocityByServer(history: any[]) {
  const daySeconds = 24 * 60 * 60
  const windowDays = 7
  const now = Math.floor(Date.now() / 1000)
  const recentStart = now - windowDays * daySeconds
  const previousStart = now - windowDays * 2 * daySeconds
  const byServer = new Map<string, { recent: number; previous: number }>()

  for (const sale of history ?? []) {
    const timestamp = Number(sale.timestamp ?? 0)
    const quantity = Number(sale.quantity ?? 0)
    if (!Number.isFinite(timestamp) || !Number.isFinite(quantity) || quantity <= 0) continue
    if (timestamp < previousStart || timestamp > now) continue

    const server = sale.worldName || '未知服务器'
    const totals = byServer.get(server) ?? { recent: 0, previous: 0 }
    if (timestamp >= recentStart) {
      totals.recent += quantity
    } else {
      totals.previous += quantity
    }
    byServer.set(server, totals)
  }

  const result = new Map<string, { dailySales: number; previousDailySales: number; trend: SalesTrend }>()
  for (const [server, totals] of byServer) {
    const dailySales = totals.recent / windowDays
    const previousDailySales = totals.previous / windowDays
    let trend: SalesTrend = 'flat'
    if (dailySales > previousDailySales) trend = 'up'
    if (dailySales < previousDailySales) trend = 'down'
    result.set(server, { dailySales, previousDailySales, trend })
  }

  return result
}

function SalesTrendIcon(props: { trend: SalesTrend }) {
  if (props.trend === 'up') {
    return (
      <svg class="size-3.5 text-emerald-500 shrink-0" aria-label="销量增长" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 19 0-14" />
        <path d="m5 12 7-7 7 7" />
      </svg>
    )
  }

  if (props.trend === 'down') {
    return (
      <svg class="size-3.5 text-red-500 shrink-0" aria-label="销量降低" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m12 5 0 14" />
        <path d="m19 12-7 7-7-7" />
      </svg>
    )
  }

  return <span class="inline-block size-3.5 shrink-0 text-center text-muted-foreground" aria-label="销量持平">-</span>
}

export function ServerListingBarChart(props: {
  directory: WorldDirectory
  listings: any[]
  history: any[]
  scope: string
  historyLoading: boolean
  historyError?: boolean
  /** 图例开关：hidden 里的系列不画（min / listing / sale / median） */
  hidden?: ReadonlySet<string>
}) {
  const { getChartGroupName, getChartGroupOrder, getChartGroupColor, computeStats, getDcNameByWorldName } = createChartHelpers(() => props.directory)
  const [hideOutliers, setHideOutliers] = createSignal(true)
  // 排序：升序 → 降序 → 取消。成交中位缺失的行始终排最后。
  const [sortMode, setSortMode] = createSignal<null | { key: 'min' | 'sale'; dir: 'asc' | 'desc' }>(null)
  const toggleSort = (key: 'min' | 'sale') => {
    const current = sortMode()
    if (!current || current.key !== key) setSortMode({ key, dir: 'asc' })
    else if (current.dir === 'asc') setSortMode({ key, dir: 'desc' })
    else setSortMode(null)
  }
  // 点图例隐藏/显示某个分组（大区）；只影响画哪些行，坐标轴仍按全部服务器算
  const [hiddenGroups, setHiddenGroups] = createSignal<ReadonlySet<string>>(new Set())
  const toggleGroup = (group: string) => {
    setHiddenGroups((prev) => {
      const next = new Set(prev)
      if (next.has(group)) next.delete(group)
      else next.add(group)
      return next
    })
  }

  // 图表列的像素宽度：决定 P25~P75 直方图用几个桶（每桶至少 ~8px，窄区间不再挤成噪点）
  const [chartWidth, setChartWidth] = createSignal(0)
  let chartObserver: ResizeObserver | undefined
  onCleanup(() => chartObserver?.disconnect())
  const measureChartColumn = (el: HTMLDivElement) => {
    chartObserver?.disconnect()
    chartObserver = new ResizeObserver((entries) => setChartWidth(entries[0].contentRect.width))
    chartObserver.observe(el)
  }
  const binCountFor = (loPct: number, hiPct: number) => {
    const width = chartWidth()
    if (width <= 0) return PROFILE_BINS
    const spanPx = ((hiPct - loPct) / 100) * width
    return Math.min(24, Math.max(3, Math.round(spanPx / 8)))
  }

  const serverData = createMemo(() => {
    const listings = props.listings
    if (!listings?.length) {
      return {
        data: [] as (ReturnType<typeof computeStats> & {
          dailySales: number
          previousDailySales: number
          salesTrend: SalesTrend
          listingPoints: { price: number; quantity: number }[]
          salePoints: { price: number; quantity: number }[]
          saleP25: number
          saleP50: number
          saleP75: number
        })[],
        scaleMin: 0,
        scaleMax: 0,
        fullMin: 0,
        fullMax: 0,
      }
    }

    const byServer: Record<string, any[]> = {}
    for (const l of listings) {
      const name = l.worldName || '未知服务器'
      if (!byServer[name]) byServer[name] = []
      byServer[name].push(l)
    }

    const servers = Object.keys(byServer).sort((a, b) => {
      const groupA = getChartGroupName(props.scope, a)
      const groupB = getChartGroupName(props.scope, b)
      const groupOrder = getChartGroupOrder(props.scope, [groupA, groupB])
      const orderA = groupOrder.indexOf(groupA)
      const orderB = groupOrder.indexOf(groupB)
      if (orderA !== orderB) return orderA - orderB
      const dcA = getDcNameByWorldName(a) || '未知'
      const dcB = getDcNameByWorldName(b) || '未知'
      if (dcA !== dcB) return dcA.localeCompare(dcB)
      return byServer[b].length - byServer[a].length
    })

    const salesByServer = computeSalesVelocityByServer(props.history)
    const salePointsByServer = new Map<string, { price: number; quantity: number }[]>()
    for (const sale of props.history ?? []) {
      const price = Number(sale.pricePerUnit ?? 0)
      if (!Number.isFinite(price) || price <= 0) continue
      const name = sale.worldName || '未知服务器'
      const point = { price, quantity: Math.max(1, Number(sale.quantity ?? 0)) }
      const list = salePointsByServer.get(name)
      if (list) list.push(point)
      else salePointsByServer.set(name, [point])
    }

    // 与 computeStats 同一套异常高价口径，保证厚度和最低/分位数字对得上
    const listingPointsOf = (server: string) => {
      const rows = byServer[server] ?? []
      const prices = rows.map((l) => Number(l.pricePerUnit ?? 0)).filter((v) => Number.isFinite(v) && v > 0)
      let cutoff = Infinity
      if (hideOutliers() && prices.length >= 4) {
        const sorted = [...prices].sort((a, b) => a - b)
        const q1 = sorted[Math.floor(sorted.length * 0.25)]
        const q3 = sorted[Math.floor(sorted.length * 0.75)]
        cutoff = q3 + 3 * (q3 - q1)
      }
      return rows
        .map((l) => ({ price: Number(l.pricePerUnit ?? 0), quantity: Math.max(1, Number(l.quantity ?? 0)) }))
        .filter((point) => Number.isFinite(point.price) && point.price > 0 && point.price <= cutoff)
    }

    const data = servers.map((server) => {
      const sales = salesByServer.get(server) ?? { dailySales: 0, previousDailySales: 0, trend: 'flat' as SalesTrend }
      const salePoints = salePointsByServer.get(server) ?? []
      const salePrices = salePoints.map((point) => point.price).sort((a, b) => a - b)
      const saleQuantile = (ratio: number) =>
        salePrices.length ? salePrices[Math.floor((salePrices.length - 1) * ratio)] : 0
      return {
        ...computeStats(server, byServer[server], hideOutliers()),
        dailySales: sales.dailySales,
        previousDailySales: sales.previousDailySales,
        salesTrend: sales.trend,
        listingPoints: listingPointsOf(server),
        salePoints,
        saleP25: saleQuantile(0.25),
        saleP50: saleQuantile(0.5),
        saleP75: saleQuantile(0.75),
      }
    })
    const sort = sortMode()
    if (sort) {
      const direction = sort.dir === 'asc' ? 1 : -1
      data.sort((a, b) => {
        const aValue = sort.key === 'min' ? a.min : a.saleP50
        const bValue = sort.key === 'min' ? b.min : b.saleP50
        // 没有成交的服务器不参与成交中位排序，永远沉底
        const aMissing = !(aValue > 0)
        const bMissing = !(bValue > 0)
        if (aMissing !== bMissing) return aMissing ? 1 : -1
        if (aMissing) return a.server.localeCompare(b.server)
        return (aValue - bValue) * direction
      })
    }

    const maxPrice = data.length > 0 ? Math.max(...data.map((d) => d.max)) : 0

    const mins = data.map((d) => d.min).filter((v) => v > 0)
    const p75s = data.map((d) => d.p75).filter((v) => v > 0)
    if (!mins.length || !p75s.length) return { data, scaleMin: 0, scaleMax: maxPrice, fullMin: 0, fullMax: maxPrice }

    const minPrice = Math.min(...mins)
    // 聚焦区间用各服 P75 的中位数推算：单个服务器 P25~P75 跨度特别大时，
    // 不能让它的 P75 把整条轴拉长、把其他服务器挤成一团；更远的价位折进右端压缩区。
    const sortedP75s = [...p75s].sort((a, b) => a - b)
    const medianP75 = sortedP75s[Math.floor((sortedP75s.length - 1) / 2)]
    const upperPrice = Math.max(medianP75 * 1.5, minPrice)
    const span = Math.max(upperPrice - minPrice, minPrice * 0.1, 1)

    return {
      data,
      scaleMin: Math.max(0, minPrice - span * 0.06),
      scaleMax: upperPrice,
      fullMin: 0,
      fullMax: maxPrice,
    }
  })

  const visibleRows = createMemo(() => {
    const hidden = hiddenGroups()
    const rows = serverData().data
    return hidden.size ? rows.filter((row) => !hidden.has(getChartGroupName(props.scope, row.server))) : rows
  })

  const valuePct = (value: number) => {
    const { scaleMin, scaleMax, fullMin, fullMax } = serverData()
    const span = scaleMax - scaleMin
    if (span <= 0) return 0

    const leftFoldPct = scaleMin > fullMin ? 6 : 0
    const rightFoldPct = fullMax > scaleMax ? 8 : 0
    const focusStart = leftFoldPct
    const focusEnd = 100 - rightFoldPct

    if (value < scaleMin) {
      const leftSpan = scaleMin - fullMin
      if (leftSpan <= 0) return 0
      return Math.min(focusStart, Math.max(0, ((value - fullMin) / leftSpan) * focusStart))
    }

    if (value > scaleMax) {
      const rightSpan = fullMax - scaleMax
      if (rightSpan <= 0) return 100
      return Math.min(100, Math.max(focusEnd, focusEnd + ((value - scaleMax) / rightSpan) * rightFoldPct))
    }

    return focusStart + ((value - scaleMin) / span) * (focusEnd - focusStart)
  }

  const axisTicks = createMemo(() => {
    const { scaleMin, scaleMax, fullMax } = serverData()
    if (scaleMax <= scaleMin) return []

    const ticks = [
      { value: scaleMin, label: formatGil(Math.round(scaleMin)) },
      { value: (scaleMin + scaleMax) / 2, label: formatGil(Math.round((scaleMin + scaleMax) / 2)) },
      { value: scaleMax, label: formatGil(Math.round(scaleMax)) },
      ...(fullMax > scaleMax ? [{ value: fullMax, label: formatGil(Math.round(fullMax)) }] : []),
    ]

    const mapped = ticks.map((tick) => ({ ...tick, label: formatAxisGil(tick.value), left: valuePct(tick.value) }))
    // 首尾（含右端压缩区的满价）优先保留，中间刻度离得太近就丢掉
    const kept: typeof mapped = []
    for (let i = 0; i < mapped.length; i++) {
      const isEdge = i === 0 || i === mapped.length - 1
      const prev = kept[kept.length - 1]
      if (!prev || isEdge || Math.abs(mapped[i].left - prev.left) >= 12) kept.push(mapped[i])
    }
    return kept
  })

  const legendGroups = createMemo(() => {
    const groups = Array.from(new Set(serverData().data.map((item) => getChartGroupName(props.scope, item.server))))
    return getChartGroupOrder(props.scope, groups)
  })

  // 表头排序：点击切 升序 → 降序 → 取消，和 shadcn DataTable 的表头排序一致
  const SortHeader = (props: { sortKey: 'min' | 'sale'; label: string }) => {
    const dir = () => (sortMode()?.key === props.sortKey ? sortMode()!.dir : null)
    return (
      // 外层的 padding 与数据单元格一致，保证表头文字和数字右边缘对齐
      <span class="block rounded px-0.5 py-0.5 text-right">
      <ButtonPrimitive
        type="button"
        onClick={() => toggleSort(props.sortKey)}
        title={dir() === 'asc' ? '降序排列' : dir() === 'desc' ? '取消排序' : '升序排列'}
        class="group inline-flex items-center gap-1 whitespace-nowrap tabular-nums text-muted-foreground transition-colors hover:text-foreground"
      >
        <Show
          when={dir()}
          fallback={
            <svg viewBox="0 0 24 24" class="size-3 shrink-0 opacity-40 transition-opacity group-hover:opacity-80" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M8 9l4-4 4 4" />
              <path d="M16 15l-4 4-4-4" />
            </svg>
          }
        >
          <svg viewBox="0 0 24 24" class="size-3 shrink-0 text-foreground" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d={dir() === 'asc' ? 'M12 19V5M5 12l7-7 7 7' : 'M12 5v14M5 12l7 7 7-7'} />
          </svg>
        </Show>
        {props.label}
      </ButtonPrimitive>
      </span>
    )
  }

  const Axis = (props: { position: 'top' | 'bottom' }) => (
    <div
      ref={(el) => {
        if (props.position === 'top') measureChartColumn(el)
      }}
      class={
        'relative h-6 border-muted/60 ' +
        (props.position === 'top' ? 'border-b mb-0.5' : 'border-t mt-0.5')
      }
      aria-hidden="true"
    >
      <For each={axisTicks()}>
        {(tick, index) => {
          const next = () => axisTicks()[index() + 1]
          // 与下一个刻度挨得太近时改为右对齐，避免两个标签叠在一起
          const transform = () =>
            tick.left <= 2
              ? 'translateX(0)'
              : tick.left >= 98 || (next() && next()!.left - tick.left < 12)
                ? 'translateX(-100%)'
                : 'translateX(-50%)'
          return (
            <>
              <div
                class={
                  'absolute h-1.5 w-px bg-muted-foreground/35 ' +
                  (props.position === 'top' ? 'bottom-0' : 'top-0')
                }
                style={{ left: `${tick.left}%` }}
              />
              <span
                class={
                  'absolute text-[10px] leading-none text-muted-foreground tabular-nums whitespace-nowrap ' +
                  (props.position === 'top' ? 'bottom-2' : 'top-2')
                }
                style={{ left: `${tick.left}%`, transform: transform() }}
              >
                {tick.label}
              </span>
            </>
          )
        }}
      </For>
    </div>
  )

  return (
    <div>
      <div class="flex flex-col gap-3 mb-3 sm:flex-row sm:items-center sm:justify-between">
        <Show when={legendGroups().length > 0}>
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground" aria-label="分组颜色图例">
            <For each={legendGroups()}>
              {(group) => {
                const color = getChartGroupColor(props.scope, group)
                const hidden = () => hiddenGroups().has(group)
                return (
                  <ButtonPrimitive
                    type="button"
                    aria-pressed={!hidden()}
                    title={hidden() ? `显示 ${group}` : `隐藏 ${group}`}
                    onClick={() => toggleGroup(group)}
                    class={
                      'inline-flex items-center gap-1.5 whitespace-nowrap rounded px-1 py-0.5 transition-all hover:bg-accent/60 ' +
                      (hidden() ? 'opacity-35' : '')
                    }
                  >
                    <span
                      class="size-2.5 rounded-[2px] border"
                      style={{
                        'background-color': `${color.solid}cc`,
                        'border-color': color.solid,
                      }}
                      aria-hidden="true"
                    />
                    <span class={hidden() ? 'line-through' : ''}>{group}</span>
                  </ButtonPrimitive>
                )
              }}
            </For>
          </div>
        </Show>
        <div class="flex flex-wrap items-center gap-3">
        <label class="inline-flex items-center gap-2 cursor-pointer select-none">
          <span class="inline-flex items-center gap-1 text-xs text-muted-foreground">
            忽略异常高价
            <Tooltip>
              <TooltipTrigger
                class="inline-flex items-center text-muted-foreground/60 transition-colors hover:text-muted-foreground"
                aria-label="忽略异常高价的机制说明"
                onClick={(e) => e.preventDefault()}
              >
                <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="size-3.5">
                  <circle cx="12" cy="12" r="10" />
                  <path d="M12 16v-4" />
                  <path d="M12 8h.01" />
                </svg>
              </TooltipTrigger>
              <TooltipPortal>
                <TooltipContent class="max-w-64 whitespace-normal">
                  按每个服务器的挂单价计算四分位距（IQR = P75 − P25），移除高于 P75 + 3×IQR 的挂单；挂单少于 4 个时不过滤。影响最低价、中位价、P25~P75 统计和条形范围。
                </TooltipContent>
              </TooltipPortal>
            </Tooltip>
          </span>
          <button
            role="switch"
            aria-checked={hideOutliers()}
            onClick={() => setHideOutliers(!hideOutliers())}
            class={
              'relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ' +
              (hideOutliers() ? 'bg-primary' : 'bg-input')
            }
          >
            <span
              class={
                'pointer-events-none block h-4 w-4 rounded-full bg-background shadow-lg ring-0 transition-transform ' +
                (hideOutliers() ? 'translate-x-4' : 'translate-x-0')
              }
            />
          </button>
        </label>
        </div>
      </div>

      {/* 统一 grid：表头和数据在同一个 grid 中，列宽全局一致 */}
      <div class="overflow-x-auto -mx-4 px-4 sm:-mx-6 sm:px-6">
        <div class="grid grid-cols-[minmax(4.5rem,auto)_minmax(4.5rem,auto)_max-content_auto_max-content_minmax(3.5rem,auto)_minmax(12rem,1fr)_minmax(3.5rem,auto)_minmax(5.5rem,auto)_minmax(5rem,auto)] gap-x-2 sm:gap-x-3 gap-y-1 text-xs px-0.5 min-w-[790px]">
        {/* 表头 */}
        <SortHeader sortKey="min" label="最低价" />
        <SortHeader sortKey="sale" label="中位成交价" />
        <span class="col-span-3 grid grid-cols-subgrid gap-x-1 tabular-nums whitespace-nowrap text-muted-foreground">
          <span class="text-right">P25</span>
          <span class="text-center">~</span>
          <span class="text-right">P75</span>
        </span>
        <span class="text-right whitespace-nowrap text-muted-foreground">服务器</span>
        <Axis position="top" />
        <span class="text-right tabular-nums whitespace-nowrap text-muted-foreground">挂单量</span>
        <span class="text-right tabular-nums whitespace-nowrap text-muted-foreground">日均销量</span>
        <span class="text-right whitespace-nowrap text-muted-foreground">上次更新</span>

        {/* 数据行：display: contents 让子元素直接参与父级 grid */}
        <For each={visibleRows()}>
          {(item) => {
            const listingPct = valuePct(item.min)
            const p25Pct = valuePct(item.p25)
            const p75Pct = valuePct(item.p75)
            const saleMedianPct = item.saleP50 > 0 ? valuePct(item.saleP50) : null
            const color = getChartGroupColor(props.scope, getChartGroupName(props.scope, item.server))
            const saleLo = item.saleP25 > 0 ? valuePct(item.saleP25) : 0
            const saleHi = item.saleP75 > 0 ? valuePct(item.saleP75) : 0
            // 挂单：只画 P25~P75 的一整块；成交：同样只画自己的 P25~P75，半幅。
            // 桶数跟着区间像素宽度走，窄区间用更少的桶，形状看得清而不是一根根毛刺。
            const listingPath = createMemo(() => {
              const bins = rangeBins(item.listingPoints, p25Pct, p75Pct, valuePct, binCountFor(p25Pct, p75Pct))
              return profilePath(bins, p25Pct, p75Pct, 2 / 3, 'down', ROW_LIMITS)
            })
            const salePath = createMemo(() => {
              if (!(item.saleP25 > 0)) return ''
              const bins = rangeBins(item.salePoints, saleLo, saleHi, valuePct, binCountFor(saleLo, saleHi))
              return bins.length ? profilePath(bins, saleLo, saleHi, 2 / 3, 'up', ROW_LIMITS) : ''
            })
            return (
              <div class="contents group cursor-pointer">
                <span class="text-right tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-accent/5 rounded px-0.5 py-0.5">
                  {formatGil(item.min)}
                </span>
                <span
                  class="text-right tabular-nums whitespace-nowrap text-amber-500 group-hover:bg-accent/5 rounded px-0.5 py-0.5"
                  title={item.saleP50 > 0 ? `近 30 天成交中位价 ${formatGil(item.saleP50)} Gil` : '近 30 天无成交记录'}
                >
                  {item.saleP50 > 0 ? formatGil(item.saleP50) : '-'}
                </span>
                <span class="col-span-3 grid grid-cols-subgrid gap-x-1 tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-accent/5 rounded py-0.5">
                  <span class="text-right">{formatGil(item.p25)}</span>
                  <span class="text-center">~</span>
                  <span class="text-right">{formatGil(item.p75)}</span>
                </span>
                <span class="text-muted-foreground truncate text-right whitespace-nowrap group-hover:bg-accent/5 rounded px-0.5 py-0.5" title={item.server}>
                  {item.server}
                </span>
                <div
                  class="relative h-4 min-w-0 overflow-hidden rounded-sm bg-muted/30"
                  title={`挂单 ${item.listingCount} 条 / ${item.listingPoints.reduce((n, p) => n + p.quantity, 0)} 件；近 30 天成交 ${item.salePoints.length} 笔`}
                >
                  {/* 行内 P25~P75 图：最低价条 + 挂单 P25~P75 整块 + 成交 P25~P75（半幅） */}
                  <svg
                    viewBox={`0 0 100 ${PROFILE_HEIGHT}`}
                    preserveAspectRatio="none"
                    class="absolute inset-0 h-full w-full"
                    aria-hidden="true"
                  >
                    {/* 最低价：极淡底色只交代大区归属，色块右边缘就是最低价位置 */}
                    <Show when={!props.hidden?.has('min')}>
                      <rect
                        x="0"
                        y="0"
                        width={Math.max(listingPct, 0.6)}
                        height={PROFILE_HEIGHT}
                        fill={color.solid}
                        fill-opacity="0.5"
                      />
                    </Show>
                    <Show when={listingPath() && !props.hidden?.has('listing')}>
                      {/* 挂单波形用该服务器所在大区的颜色，浅填充；成交仍是琥珀色 */}
                      <path
                        d={listingPath()}
                        fill={color.solid}
                        fill-opacity="0.15"
                        stroke={color.solid}
                        stroke-opacity="0.3"
                        stroke-width="1"
                        stroke-linejoin="round"
                        vector-effect="non-scaling-stroke"
                      />
                    </Show>
                    <Show when={salePath() && !props.hidden?.has('sale')}>
                      <path d={salePath()} fill="#f59e0b" fill-opacity="0.7" />
                    </Show>
                    {/* 中位刻度：固定行高 2/3，以基线为中心（只标成交中位） */}
                    <Show when={saleMedianPct != null && !props.hidden?.has('median')}>
                      <line
                        x1={saleMedianPct!}
                        y1={PROFILE_CENTER - PROFILE_HEIGHT / 3}
                        x2={saleMedianPct!}
                        y2={PROFILE_CENTER + PROFILE_HEIGHT / 3}
                        stroke="#b45309"
                        stroke-width="3"
                        stroke-opacity="0.5"
                        vector-effect="non-scaling-stroke"
                      />
                    </Show>
                  </svg>
                </div>
                <span class="text-right tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-accent/5 rounded px-0.5 py-0.5">
                  {item.listingCount.toLocaleString('zh-CN')}
                </span>
                <span
                  class="inline-flex items-center justify-end gap-1 text-right tabular-nums whitespace-nowrap text-muted-foreground group-hover:bg-accent/5 rounded px-0.5 py-0.5"
                  title={
                    props.historyLoading
                      ? undefined
                      : props.historyError
                        ? '成交历史加载失败'
                        : `最近 7 天 ${formatDailySales(item.dailySales)}，前 7 天 ${formatDailySales(item.previousDailySales)}`
                  }
                >
                  {/* 销量由 history 接口计算：加载中显示骨架（"-" 会被误读为无数据）；
                      无数据且失败显示 "-" 并以 title 说明；有旧数据时刷新失败仍显示旧值（错误走 toast） */}
                  <Show when={!props.historyLoading} fallback={<Skeleton class="h-3 w-10" />}>
                    <Show when={!props.historyError} fallback={<span>-</span>}>
                      <span>{formatDailySales(item.dailySales)}</span>
                      <SalesTrendIcon trend={item.salesTrend} />
                    </Show>
                  </Show>
                </span>
                <span class="text-right whitespace-nowrap text-muted-foreground group-hover:bg-accent/5 rounded px-0.5 py-0.5" title={item.lastReviewTime ? new Date(item.lastReviewTime).toLocaleString('zh-CN') : undefined}>
                  {formatTime(item.lastReviewTime)}
                </span>
              </div>
            )
          }}
        </For>
        <div></div>
        <div></div>
        <div class="col-span-3"></div>
        <div></div>
        <Axis position="bottom" />
        <div></div>
        <div></div>
        <div></div>
      </div>
      </div>
    </div>
  )
}

export function ServerHistoryTrendChart(props: { history: any[]; animate?: boolean }) {
  let canvasRef!: HTMLCanvasElement
  const [loadError, setLoadError] = createSignal(false)
  const [renderState, setRenderState] = createSignal('loading')

  createEffect(() => {
    const data = props.history
    if (loadError()) return
    if (!canvasRef || !data?.length) return
    const animate = props.animate !== false
    setRenderState('loading')

    let chart: { destroy: () => void } | undefined
    let disposed = false
    onCleanup(() => {
      disposed = true
      chart?.destroy()
    })

    void loadChart().then((Chart) => {
      if (disposed || !canvasRef) return

      const existing = Chart.getChart(canvasRef)
      if (existing) existing.destroy()

      const ctx = canvasRef.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D context is unavailable')

      const byDay: Record<string, { prices: number[]; volume: number }> = {}
      for (const h of data) {
        const d = new Date(h.timestamp * 1000)
        const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
        if (!byDay[day]) byDay[day] = { prices: [], volume: 0 }
        byDay[day].prices.push(h.pricePerUnit)
        byDay[day].volume += h.quantity
      }

      const days = Object.keys(byDay).sort()
      const dayLabels = days.map(d => {
        const [, m, day] = d.split('-')
        return `${Number(m)}/${Number(day)}`
      })
      const avgPrices = days.map(d => {
        const arr = byDay[d].prices
        return arr.reduce((a, b) => a + b, 0) / arr.length
      })
      const minPrices = days.map(d => Math.min(...byDay[d].prices))
      const maxPrices = days.map(d => Math.max(...byDay[d].prices))
      const volumes = days.map(d => byDay[d].volume)

      chart = new Chart(ctx, {
        plugins: [{ id: 'report-readiness', afterRender: () => { if (!disposed) setRenderState('ready') } }],
        type: 'line',
        data: {
          labels: dayLabels,
          datasets: [
            {
              label: '成交量',
              type: 'bar' as any,
              data: volumes,
              yAxisID: 'y1',
              barMaxWidth: 12,
              backgroundColor: 'rgba(74, 222, 128, 0.4)',
            },
            {
              label: '均价',
              data: avgPrices,
              borderColor: '#6366f1',
              backgroundColor: '#6366f1',
              borderWidth: 2,
              tension: 0.3,
              pointRadius: 0,
              pointHoverRadius: 4,
            },
            {
              label: '最低',
              data: minPrices,
              borderColor: 'transparent',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              fill: '+1',
              pointRadius: 0,
              tension: 0.3,
            },
            {
              label: '最高',
              data: maxPrices,
              borderColor: 'transparent',
              backgroundColor: 'rgba(99, 102, 241, 0.1)',
              fill: false,
              pointRadius: 0,
              tension: 0.3,
            },
          ],
        },
        options: {
          animation: animate ? undefined : false,
          responsive: true,
          maintainAspectRatio: false,
          interaction: { intersect: false, mode: 'index' },
          plugins: {
            legend: { display: true, position: 'top' },
            tooltip: {
              backgroundColor: '#ffffff',
              titleColor: '#0a0a0a',
              bodyColor: '#0a0a0a',
              borderColor: '#e5e5e5',
              borderWidth: 1,
              padding: 10,
              callbacks: {
                label: (item: any) => {
                  const v = item.parsed?.y
                  if (v == null) return ''
                  return `${item.dataset.label}: ${item.datasetIndex === 0 ? v.toLocaleString('zh-CN') : formatGil(v)}${item.datasetIndex === 0 ? '' : ' Gil'}`
                },
              },
            },
          },
          scales: {
            x: {
              grid: { display: false },
              ticks: { maxTicksLimit: 8 },
            },
            y: {
              type: 'logarithmic',
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: {
                callback: (v: any) => {
                  if (typeof v !== 'number') return v
                  if (v >= 1000000) return `${(v / 1000000).toFixed(1)}M`
                  if (v >= 1000) return `${(v / 1000).toFixed(0)}k`
                  return formatGil(v)
                },
              },
            },
            y1: {
              type: 'linear',
              position: 'right',
              grid: { display: false },
              display: true,
            },
          },
        },
      })

      if (disposed) chart.destroy()
    }).catch(() => {
      if (!disposed) { setRenderState('error'); setLoadError(true) }
    })
  })

  return (
    <Show when={!loadError()} fallback={<ChartLoadError onRetry={() => setLoadError(false)} />}>
      <div class="h-[240px] sm:h-[320px] w-full" role="img" aria-label="服务器历史价格走势图">
        <canvas ref={canvasRef} aria-hidden="true" data-chart-state={renderState()} />
      </div>
    </Show>
  )
}

export function ServerHistoryScatterChart(props: { directory: WorldDirectory; history: any[]; scope: string; animate?: boolean }) {
  const { getScopeKind, getChartGroupName, getChartGroupOrder, getChartGroupColor } = createChartHelpers(() => props.directory)
  let canvasRef!: HTMLCanvasElement
  const [loadError, setLoadError] = createSignal(false)
  const [renderState, setRenderState] = createSignal('loading')

  createEffect(() => {
    const data = props.history
    const scope = props.scope
    if (loadError()) return
    if (!canvasRef || !data?.length) return
    const animate = props.animate !== false
    setRenderState('loading')

    let chart: { destroy: () => void } | undefined
    let disposed = false
    onCleanup(() => {
      disposed = true
      chart?.destroy()
    })

    void loadChart().then((Chart) => {
      if (disposed || !canvasRef) return

      const existing = Chart.getChart(canvasRef)
      if (existing) existing.destroy()

      const ctx = canvasRef.getContext('2d')
      if (!ctx) throw new Error('Canvas 2D context is unavailable')

      const now = Date.now()
      const day7Ago = now - 7 * 24 * 60 * 60 * 1000
      const filtered = data.filter(h => h.timestamp * 1000 >= day7Ago)

      const allPrices = filtered.map(h => h.pricePerUnit)
      const maxPrice = allPrices.length > 0 ? Math.max(...allPrices) : 0

      const scopeKind = getScopeKind(scope)
      const byGroup: Record<string, any[]> = {}

      for (const h of filtered) {
        const group = getChartGroupName(scope, h.worldName)
        if (!byGroup[group]) byGroup[group] = []
        byGroup[group].push({
          x: h.timestamp * 1000,
          y: h.pricePerUnit,
          qty: h.quantity,
          world: h.worldName,
        })
      }

      const groupNames = getChartGroupOrder(scope, Object.keys(byGroup))
      const datasets = groupNames.map(name => ({
        label: name,
        data: byGroup[name],
        pointRadius: (ctx: any) => {
          const qty = ctx.raw?.qty ?? 1
          return Math.min(20, Math.max(6, qty * 2))
        },
        pointBackgroundColor: getChartGroupColor(scope, name).point,
        pointBorderColor: 'transparent',
      }))

      if (scopeKind === 'world' && datasets.length === 0) {
        datasets.push({
          label: scope,
          data: filtered.map(h => ({
            x: h.timestamp * 1000,
            y: h.pricePerUnit,
            qty: h.quantity,
            world: h.worldName,
          })),
          pointRadius: (ctx: any) => {
            const qty = ctx.raw?.qty ?? 1
            return Math.min(20, Math.max(6, qty * 2))
          },
          pointBackgroundColor: getChartGroupColor(scope, scope).point,
          pointBorderColor: 'transparent',
        })
      }

      chart = new Chart(ctx, {
        plugins: [{ id: 'report-readiness', afterRender: () => { if (!disposed) setRenderState('ready') } }],
        type: 'scatter',
        data: { datasets },
        options: {
          animation: animate ? undefined : false,
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { display: scopeKind !== 'world', position: 'top' },
            tooltip: {
              backgroundColor: '#ffffff',
              titleColor: '#0a0a0a',
              bodyColor: '#0a0a0a',
              borderColor: '#e5e5e5',
              borderWidth: 1,
              padding: 10,
              callbacks: {
                title: (items: any[]) => {
                  const raw = items[0]?.raw
                  if (!raw) return ''
                  const d = new Date(raw.x)
                  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
                },
                label: (item: any) => {
                  const raw = item.raw
                  const lines: string[] = []
                  lines.push(`单价: ${formatGil(raw.y)} Gil`)
                  lines.push(`数量: ${raw.qty}`)
                  if (raw.world) lines.push(`服务器: ${raw.world}`)
                  return lines
                },
              },
            },
          },
          scales: {
            x: {
              type: 'linear',
              min: day7Ago,
              max: now,
              grid: { display: false },
              ticks: {
                maxTicksLimit: 8,
                callback: (v: any) => {
                  const d = new Date(v)
                  return `${d.getMonth() + 1}/${d.getDate()}`
                },
              },
            },
            y: {
              min: 0,
              max: Math.ceil(maxPrice * 1.1),
              grid: { color: 'rgba(0,0,0,0.05)' },
              ticks: {
                callback: (v: any) => {
                  if (typeof v !== 'number') return v
                  if (v >= 10000) return `${(v / 10000).toFixed(0)}万`
                  return formatGil(v)
                },
              },
            },
          },
        },
      })

      if (disposed) chart.destroy()
    }).catch(() => {
      if (!disposed) { setRenderState('error'); setLoadError(true) }
    })
  })

  return (
    <Show when={!loadError()} fallback={<ChartLoadError onRetry={() => setLoadError(false)} />}>
      <div class="h-[240px] sm:h-[300px] w-full" role="img" aria-label="服务器历史成交散点图">
        <canvas ref={canvasRef} aria-hidden="true" data-chart-state={renderState()} />
      </div>
    </Show>
  )
}
