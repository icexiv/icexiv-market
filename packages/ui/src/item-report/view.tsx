import { createMemo, createSignal, createEffect, Show, For, onMount, onCleanup, type JSX } from 'solid-js'
import { Root as ButtonPrimitive } from '@kobalte/core/button'
import { computeItemStats, filterMarketQuality, getIconUrl, baseUrl, isFishItem, type ItemInfo, type WorldDirectory, type ItemReportMarketState, type ItemReportHistoryState, type MarketQuality } from '@xiv-market/shared'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '../card'
import { QualityBadge } from '../quality-badge'
import { Skeleton } from '../skeleton'
import { Table, TableBody, TableRow, TableHead, TableCell, TableHeader } from '../table'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '../tabs'
import { EmptyState } from '../empty-state'
import { ItemIcon } from '../item-icon'
import { RefreshButton } from '../refresh-button'
import { WorldBadge } from '../world-badge'
import { Tooltip, TooltipPortal, TooltipTrigger, TooltipContent } from '../tooltip'
import { PriceRangeStrip } from './price-range-strip'
import { ListingTableSkeleton, ListingChartSkeleton, ChartErrorCard, ServerListingBarChart, ServerHistoryTrendChart, ServerHistoryScatterChart } from './charts'
import { formatGil, formatDailySales, formatTime } from './format'

// 挂单/成交分布图例：统计卡与图表共用同一套小图形，避免两处各写一遍。
// 传入 onToggle 时每一项变成开关，hidden 里的系列在图上不画。
function DistributionLegend(props: {
  showMin?: boolean
  class?: string
  hidden?: ReadonlySet<string>
  onToggle?: (key: string) => void
}) {
  const items = () => [
    ...(props.showMin === false
      ? []
      : [{
          key: 'min',
          label: '最低价',
          icon: (
            <svg viewBox="0 0 18 10" class="h-2.5 w-[18px]" aria-hidden="true">
              <rect x="0" y="0" width="7" height="10" rx="1" class="fill-primary" fill-opacity="0.2" />
            </svg>
          ),
        }]),
    {
      key: 'listing',
      label: '挂单 P25~P75',
      icon: (
        <svg viewBox="0 0 18 10" class="h-2.5 w-[18px]" aria-hidden="true">
          <path d="M1 5 C5 1 13 1 17 5 C13 9 5 9 1 5 Z" class="fill-primary" fill-opacity="0.25" />
        </svg>
      ),
    },
    {
      key: 'sale',
      label: '成交 P25~P75',
      icon: (
        <svg viewBox="0 0 18 10" class="h-2.5 w-[18px]" aria-hidden="true">
          <path d="M1 5 C5 2 13 2 17 5 C13 8 5 8 1 5 Z" class="fill-amber-500" fill-opacity="0.7" />
        </svg>
      ),
    },
    {
      key: 'median',
      label: '成交中位',
      icon: (
        <svg viewBox="0 0 18 10" class="h-2.5 w-[18px]" aria-hidden="true">
          <line x1="9" y1="0" x2="9" y2="10" class="stroke-amber-700" stroke-width="2.5" stroke-opacity="0.5" />
        </svg>
      ),
    },
  ]

  return (
    <div class={props.class ?? 'flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-muted-foreground'}>
      <For each={items()}>
        {(item) => {
          const hidden = () => props.hidden?.has(item.key) ?? false
          const body = (
            <span class={'inline-flex items-center gap-1 ' + (hidden() ? 'line-through' : '')}>
              {item.icon}
              {item.label}
            </span>
          )
          return props.onToggle ? (
            <ButtonPrimitive
              type="button"
              aria-pressed={!hidden()}
              title={hidden() ? `显示 ${item.label}` : `隐藏 ${item.label}`}
              onClick={() => props.onToggle!(item.key)}
              class={
                'inline-flex cursor-pointer items-center gap-1 rounded px-1.5 py-0.5 transition-colors ' +
                (hidden()
                  ? 'text-muted-foreground/55 line-through hover:bg-accent/40'
                  : 'bg-muted/60 text-muted-foreground hover:bg-accent hover:text-foreground')
              }
            >
              {body}
            </ButtonPrimitive>
          ) : (
            body
          )
        }}
      </For>
    </div>
  )
}

export interface ItemReportViewProps {
  itemId: number
  item: ItemInfo
  scope: string
  directory: WorldDirectory
  market: ItemReportMarketState
  history: ItemReportHistoryState
  quality?: MarketQuality
  onQualityChange?: (quality: MarketQuality) => void
  showDetails?: boolean
  animateCharts?: boolean
  sticky?: boolean
  backLink?: JSX.Element
  actions?: (compact: boolean) => JSX.Element
}

/** Shared live report. All data and acquisition states arrive through props. */
export function ItemReportView(props: ItemReportViewProps) {
  const directory = () => props.directory
  const itemId = () => String(props.itemId)
  const scope = () => props.scope
  const [activeTab, setActiveTab] = createSignal('listings')
  const [historyChartTab, setHistoryChartTab] = createSignal('line')
  const [copyFeedback, setCopyFeedback] = createSignal('')
  const [copyTooltipOpen, setCopyTooltipOpen] = createSignal(false)
  const copied = () => copyFeedback() === '已复制'
  let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined
  let copyRequest = 0
  createEffect(() => {
    props.itemId
    props.item.name
    setCopyFeedback('')
    setCopyTooltipOpen(false)
    onCleanup(() => {
      copyRequest++
      clearTimeout(copyFeedbackTimer)
    })
  })
  const [isScrolled, setIsScrolled] = createSignal(false)

  // 图例开关：控制图上要画哪些系列（min / listing / sale / median），统计卡与图表共用
  const [hiddenSeries, setHiddenSeries] = createSignal<ReadonlySet<string>>(new Set(['sale']))
  const toggleSeries = (key: string) => {
    setHiddenSeries((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  let sentinelRef!: HTMLDivElement

  onMount(() => {
    if (!props.sticky) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        setIsScrolled(!entry.isIntersecting)
      },
      { threshold: 0, rootMargin: '-56px 0px 0px 0px' }
    )
    if (sentinelRef) observer.observe(sentinelRef)
    onCleanup(() => observer.disconnect())
  })

  const marketData = () => props.market.data ?? null
  const currentListings = createMemo(() => props.directory.filterRows(marketData()?.listings ?? [], scope()))
  const history = createMemo(() => props.directory.filterRows(props.history.data?.entries ?? [], scope()))
  const showHistoryWorld = createMemo(() => history().some(sale => Boolean(sale.worldName) && sale.worldName !== scope()))
  const stats = createMemo(() => computeItemStats(marketData(), currentListings(), props.item.canBeHq))

  // 每个品质的挂单点 / 成交点：给 P25~P75 图画厚度，也给成交自己的区间
  const qualitySeries = createMemo(() => {
    const build = (hq: boolean) => {
      const listings = filterMarketQuality(currentListings(), hq ? 'hq' : 'nq')
        .map((l) => ({ price: Number(l.pricePerUnit ?? 0), quantity: Math.max(1, Number(l.quantity ?? 0)) }))
        .filter((p) => Number.isFinite(p.price) && p.price > 0)
      const sales = filterMarketQuality(history(), hq ? 'hq' : 'nq')
        .map((s) => ({ price: Number(s.pricePerUnit ?? 0), quantity: Math.max(1, Number(s.quantity ?? 0)) }))
        .filter((p) => Number.isFinite(p.price) && p.price > 0)
      const prices = sales.map((p) => p.price).sort((a, b) => a - b)
      const quartile = (ratio: number) => (prices.length ? prices[Math.floor((prices.length - 1) * ratio)] : 0)
      return { listings, sales, saleP25: quartile(0.25), saleP50: quartile(0.5), saleP75: quartile(0.75) }
    }
    return { nq: build(false), hq: build(true) }
  })

  // NQ/HQ 双条对比时的共享坐标域，让两条区间条可以上下直观对比。
  // 成交区间可能落在挂单区间之外，一并纳入域内。
  const sharedDistDomain = createMemo(() => {
    const nq = stats()?.nqDist
    const hq = stats()?.hqDist
    if (!nq || !hq) return null
    const series = qualitySeries()
    const lows = [nq.min, hq.min, series.nq.saleP25, series.hq.saleP25].filter((v) => v > 0)
    const highs = [nq.p75, hq.p75, series.nq.saleP75, series.hq.saleP75].filter((v) => v > 0)
    const lo = Math.min(...lows)
    const hi = Math.max(...highs)
    const span = hi > lo ? hi - lo : Math.max(hi * 0.1, 1)
    // 左端只留出圆点半径的余量：最低价就贴着条的最左侧
    return { lo: Math.max(0, lo - span * 0.015), hi: hi + span * 0.18 }
  })

  // Explicit quality never falls back based on current stock. Without a quality
  // prop, the web page keeps its automatic HQ/NQ initial selection.
  const [localQuality, setLocalQuality] = createSignal<MarketQuality>('hq')
  const qualityFilter = () => props.item.canBeHq ? props.quality ?? localQuality() : 'nq'
  let qualityTouched = false
  createEffect(() => {
    if (props.quality !== undefined || qualityTouched) return
    const s = stats()
    if (!s) return
    setLocalQuality(s.hqDist ? 'hq' : 'nq')
  })
  const handleQualityChange = (q: MarketQuality) => {
    qualityTouched = true
    setLocalQuality(q)
    props.onQualityChange?.(q)
  }
  const filteredListings = createMemo(() => filterMarketQuality(currentListings(), qualityFilter()))
  const filteredHistory = createMemo(() => filterMarketQuality(history(), qualityFilter()))
  // 统计卡中未选中品质的行淡化
  const qualityRowClass = (q: 'nq' | 'hq') =>
    'transition-opacity ' + (qualityFilter() === q ? '' : 'opacity-40')

  // 品质标签：HQ 始终用 badge（有效信号）；NQ 仅在物品可 HQ 时用 badge，
  // 不可 HQ 的物品没有品质区分，退化为纯文本避免噪音
  const canBeHqItem = createMemo(() => props.item.canBeHq)
  const QualityTag = (props: { hq: boolean; class?: string }) => (
    <Show
      when={props.hq || canBeHqItem()}
      fallback={<span class="text-muted-foreground">NQ</span>}
    >
      <QualityBadge hq={props.hq} class={props.class} />
    </Show>
  )

  // 品质行：badge + 最低挂单 + 价格分布条，双品质时整行可点击选择
  const QualityRow = (props: {
    hq: boolean
    dist: { min: number; p25: number; p50: number; p75: number }
    minListing: any
    selectable: boolean
  }) => {
    const series = () => (props.hq ? qualitySeries().hq : qualitySeries().nq)
    const selected = () => qualityFilter() === (props.hq ? 'hq' : 'nq')
    return (
      <ButtonPrimitive
        type="button"
        disabled={!props.selectable}
        aria-pressed={props.selectable ? selected() : undefined}
        onClick={() => props.selectable && handleQualityChange(props.hq ? 'hq' : 'nq')}
        class={
          'col-span-2 grid grid-cols-subgrid items-center rounded-md px-2 py-1.5 text-left transition-all ' +
          (props.selectable
            ? 'cursor-pointer hover:bg-accent/60 ' + (selected() ? '' : 'opacity-40')
            : 'cursor-default')
        }
      >
        {/* 品质标签与最低价同属左侧一列；两行共用同一列宽，价格长短不同也不会让区间条错位 */}
        <div class="flex items-center gap-3">
        <QualityTag hq={props.hq} class="shrink-0" />
        <div class="whitespace-nowrap">
          <Show when={props.minListing} fallback={<span class="text-muted-foreground">-</span>}>
            <div class="flex items-baseline gap-1">
              <span class="text-lg font-bold tracking-tight tabular-nums">
                {formatGil(Number(props.minListing.pricePerUnit))}
              </span>
              <span class="text-xs text-muted-foreground">Gil</span>
            </div>
            <WorldBadge directory={directory()}
              class="text-[10px] text-muted-foreground"
              worldName={props.minListing.worldName || scope()}
            />
          </Show>
        </div>
        </div>
        <div class="min-w-0">
          <PriceRangeStrip
            min={props.dist.min}
            p25={props.dist.p25}
            p50={props.dist.p50}
            p75={props.dist.p75}
            domain={sharedDistDomain() ?? undefined}
            listingPoints={series().listings}
            salePoints={series().sales}
            saleP25={series().saleP25}
            saleP50={series().saleP50}
            saleP75={series().saleP75}
          />
        </div>
      </ButtonPrimitive>
    )
  }

  const qualityToggle = () => (
    <Show when={canBeHqItem()}>
      {/* 两态切换：点击整个区域即翻到另一品质 */}
      <ButtonPrimitive
        type="button"
        class="inline-flex cursor-pointer items-center rounded-md border border-input bg-background p-0.5 text-xs font-medium"
        aria-label="切换 NQ/HQ 品质筛选"
        title="切换 NQ/HQ 品质筛选"
        onClick={() => handleQualityChange(qualityFilter() === 'hq' ? 'nq' : 'hq')}
      >
        <span
          class={
            'rounded px-1.5 py-0.5 transition-colors ' +
            (qualityFilter() === 'nq'
              ? 'bg-secondary text-secondary-foreground'
              : 'text-muted-foreground')
          }
        >
          NQ
        </span>
        <span
          class={
            'rounded px-1.5 py-0.5 transition-colors ' +
            (qualityFilter() === 'hq'
              ? 'bg-amber-100 text-amber-800'
              : 'text-muted-foreground')
          }
        >
          HQ
        </span>
      </ButtonPrimitive>
    </Show>
  )

  const handleCopyName = async () => {
    const request = ++copyRequest
    clearTimeout(copyFeedbackTimer)
    setCopyFeedback('')
    try {
      await navigator.clipboard.writeText(props.item.name)
      if (request !== copyRequest) return
      setCopyFeedback('已复制')
    } catch {
      if (request !== copyRequest) return
      setCopyFeedback('复制失败，请重试')
    }
    copyFeedbackTimer = setTimeout(() => {
      setCopyFeedback('')
      setCopyTooltipOpen(false)
    }, 2000)
  }

  return (
    <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8" data-item-report data-quality={qualityFilter()}>
      {/* Sentinel: Intersection Observer 监听此元素是否离开视口 */}
      <div ref={sentinelRef} class="h-px -mt-px" />

      {/* Sticky Header */}
      <div
        class={
          (props.sticky ? 'sticky top-14 z-40 ' : '') + '-mx-4 px-4 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8 flex items-center gap-2 sm:gap-3 transition-all duration-300 ' +
          (isScrolled() ? 'h-14 py-2 bg-background/80 backdrop-blur-md shadow-sm' : 'h-20 py-3 mb-6 sm:py-4 sm:mb-8')
        }
      >
        {/* 返回按钮 */}
        {props.backLink}

        {/* 物品图标 */}
        <ItemIcon
          urls={getIconUrl(props.item.icon)}
          class={
            'rounded flex-shrink-0 transition-all duration-300 ' +
            (isScrolled() ? 'h-6 w-6' : 'h-10 w-10')
          }
        />

        {/* 物品信息 */}
        <div class="min-w-0 flex-1">
          {/* 第一行：名称 + 操作按钮（移动端）/ 名称 + 按钮 + ScopeSelect（桌面端） */}
          <div class="flex items-center gap-1 sm:gap-2">
            <h1
              class={
                'font-semibold tracking-tight truncate transition-all duration-300 ' +
                (isScrolled() ? 'text-base' : 'text-xl sm:text-2xl')
              }
            >
              {props.item.name}
            </h1>

            {/* 操作按钮组 */}
            <div class="flex items-center gap-0.5 flex-shrink-0">
              {/* 复制按钮 */}
              <Tooltip open={Boolean(copyFeedback()) || copyTooltipOpen()} onOpenChange={setCopyTooltipOpen}>
                <TooltipTrigger
                  type="button"
                  onClick={handleCopyName}
                  class={
                    'rounded-md hover:bg-accent/80 hover:text-accent-foreground transition-all duration-200 flex items-center justify-center text-muted-foreground ' +
                    (isScrolled() ? 'h-6 w-6' : 'h-7 w-7')
                  }
                  aria-label={copyFeedback() || '复制名称'}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class={isScrolled() ? 'h-3.5 w-3.5' : 'h-4 w-4'} aria-hidden="true">
                    <Show when={copied()} fallback={<>
                      <rect width="14" height="14" x="8" y="8" rx="2" ry="2" />
                      <path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" />
                    </>}>
                      <path d="m5 12 4 4L19 6" />
                    </Show>
                  </svg>
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>{copyFeedback() || '复制名称'}</TooltipContent>
                </TooltipPortal>
              </Tooltip>
              <span role="status" class="sr-only">{copyFeedback()}</span>

              {/* 灰机wiki */}
              <Tooltip>
                <TooltipTrigger
                  as="a"
                  href={`https://ff14.huijiwiki.com/wiki/${encodeURIComponent('物品:' + props.item.name)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={
                    'rounded-md hover:bg-accent/80 hover:opacity-100 opacity-70 transition-all duration-200 flex items-center justify-center overflow-hidden ' +
                    (isScrolled() ? 'h-6 w-6' : 'h-7 w-7')
                  }
                  aria-label="在灰机wiki查看"
                >
                  <img src={`${baseUrl()}huiji.webp`} alt="灰机wiki" class={isScrolled() ? 'h-3.5 w-3.5' : 'h-4 w-4'} draggable="false" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>在灰机wiki查看</TooltipContent>
                </TooltipPortal>
              </Tooltip>

              {/* Garland Tools */}
              <Tooltip>
                <TooltipTrigger
                  as="a"
                  href={`https://garlandtools.cn/db/#item/${itemId()}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={
                    'rounded-md hover:bg-accent/80 hover:opacity-100 opacity-70 transition-all duration-200 flex items-center justify-center overflow-hidden ' +
                    (isScrolled() ? 'h-6 w-6' : 'h-7 w-7')
                  }
                  aria-label="在 Garland Tools 查看"
                >
                  <img src={`${baseUrl()}garland.webp`} alt="Garland Tools" class={isScrolled() ? 'h-3.5 w-3.5' : 'h-4 w-4'} draggable="false" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>在 Garland Tools 查看</TooltipContent>
                </TooltipPortal>
              </Tooltip>

              {/* IceXIV DB */}
              <Tooltip>
                <TooltipTrigger
                  as="a"
                  href={`https://db.icexiv.top/items/${itemId()}.html`}
                  target="_blank"
                  rel="noopener noreferrer"
                  class={
                    'rounded-md hover:bg-accent/80 hover:opacity-100 opacity-70 transition-all duration-200 flex items-center justify-center overflow-hidden ' +
                    (isScrolled() ? 'h-6 w-6' : 'h-7 w-7')
                  }
                  aria-label="在 IceXIV DB 查看"
                >
                  <img src={`${baseUrl()}icexivdb.png`} alt="IceXIV DB" class={isScrolled() ? 'h-3.5 w-3.5' : 'h-4 w-4'} draggable="false" />
                </TooltipTrigger>
                <TooltipPortal>
                  <TooltipContent>在 IceXIV DB 查看</TooltipContent>
                </TooltipPortal>
              </Tooltip>

              {/* 鱼糕：只有水产品才有 */}
              <Show when={isFishItem(props.itemId)}>
                <Tooltip>
                  <TooltipTrigger
                    as="a"
                    href={`https://fish.ffmomola.com/ng/#/wiki/fish/${itemId()}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    class={
                      'rounded-md hover:bg-accent/80 hover:opacity-100 opacity-70 transition-all duration-200 flex items-center justify-center overflow-hidden ' +
                      (isScrolled() ? 'h-6 w-6' : 'h-7 w-7')
                    }
                    aria-label="在鱼糕查看"
                  >
                    <img src={`${baseUrl()}fishcake.webp`} alt="鱼糕" class={isScrolled() ? 'h-3.5 w-3.5' : 'h-4 w-4'} draggable="false" />
                  </TooltipTrigger>
                  <TooltipPortal>
                    <TooltipContent>在鱼糕查看</TooltipContent>
                  </TooltipPortal>
                </Tooltip>
              </Show>
            </div>

            <div class="flex-1 min-w-2 sm:min-w-4" />

            {/* 更新时间 - 桌面端 */}
            <div
              class={
                'hidden sm:block flex-shrink-0 transition-all duration-300 ' +
                (isScrolled() ? 'opacity-0 w-0' : 'opacity-100')
              }
            >
              <Show when={stats()?.lastUploadTime}>
                <p class="text-sm text-muted-foreground whitespace-nowrap">
                  更新于 {formatTime(stats()?.lastUploadTime ?? 0)}
                </p>
              </Show>
            </div>

            {/* 数据范围选择器 + 品质筛选 + 刷新按钮 - 桌面端 */}
            <div class="hidden sm:flex items-center gap-1.5 flex-shrink-0">
              {qualityToggle()}
              <Show when={props.actions} fallback={<span class="text-xs text-muted-foreground">{scope()}</span>}>
                {props.actions?.(isScrolled())}
              </Show>
            </div>
          </div>

          {/* 第二行：ID（移动端）/ ID + ScopeSelect（桌面端） */}
          <div
            class={
              'flex items-center gap-2 transition-all duration-300 overflow-hidden ' +
              (isScrolled() ? 'h-0 opacity-0 mt-0' : 'h-5 opacity-100 mt-1')
            }
          >
            <span class="text-sm text-muted-foreground">#{itemId()}</span>
            <div class="flex-1" />
            {/* 移动端 ScopeSelect + 品质筛选 + 刷新按钮 */}
            <div class="sm:hidden flex items-center gap-1.5">
              {qualityToggle()}
              <Show when={props.actions} fallback={<span class="text-xs text-muted-foreground">{scope()}</span>}>
                {props.actions?.(isScrolled())}
              </Show>
            </div>
          </div>
        </div>
      </div>

      <Show
        when={stats()}
        fallback={
          <Show
            when={props.market.data !== undefined}
            fallback={
              <Show
                when={!props.market.error}
                fallback={
                  <Card class="mb-6">
                    <CardContent>
                      <EmptyState
                        variant="error"
                        title="市场数据加载失败"
                        description={props.market.error ?? undefined}
                        action={<RefreshButton loading={props.market.loading} onClick={() => props.market.retry?.()} />}
                      />
                    </CardContent>
                  </Card>
                }
              >
                <Card class="mb-6" role="status">
                  <span class="sr-only">加载中</span>
                  <CardContent class="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-0 sm:divide-x sm:divide-border">
                    <div class="min-w-0 flex-1 space-y-3 sm:pr-6">
                      <Skeleton class="h-3 w-28 px-2" />
                      <For each={Array.from({ length: 2 })}>
                        {() => (
                          <div class="flex items-center gap-3 px-2">
                            <Skeleton class="h-5 w-8" />
                            <Skeleton class="h-8 w-24" />
                            <Skeleton class="h-1.5 flex-1" />
                          </div>
                        )}
                      </For>
                    </div>
                    <div class="flex shrink-0 gap-8 sm:flex-col sm:gap-3 sm:pl-6">
                      <div class="space-y-1.5"><Skeleton class="h-3 w-14" /><Skeleton class="h-5 w-20" /></div>
                      <div class="space-y-1.5"><Skeleton class="h-3 w-14" /><Skeleton class="h-5 w-16" /></div>
                    </div>
                  </CardContent>
                </Card>
              </Show>
            }
          >
            <Card class="mb-6">
              <CardContent>
                <EmptyState
                  title="暂无市场数据"
                  description="该物品在当前范围内没有挂单与成交记录，可尝试切换更大的数据范围"
                />
              </CardContent>
            </Card>
          </Show>
        }
      >
        <Card class="mb-6" data-report-section="stats">
          <CardContent class="flex flex-col gap-3 sm:gap-2">
            {/* 标题与图例占满整卡宽度，右边缘与下方图表卡的图例对齐 */}
            <div class="flex items-center justify-between gap-3">
              <span class="px-2 text-xs font-medium text-muted-foreground">最低挂单 · 挂单与成交分布</span>
              <DistributionLegend showMin={false} class="hidden shrink-0 items-center justify-end gap-x-3 text-[10px] text-muted-foreground sm:flex" />
            </div>
            <div class="flex flex-col gap-5 sm:flex-row sm:items-center sm:gap-0 sm:divide-x sm:divide-border">
            {/* 最低挂单 + 价格分布：每个品质一行，双品质时整行可点击选择 */}
            <div class="min-w-0 flex-1 sm:pr-6">
              <Show
                when={stats()?.nqDist || stats()?.hqDist}
                fallback={<div class="text-muted-foreground">-</div>}
              >
                <div class="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                  <Show when={stats()?.nqDist}>
                    {(dist) => (
                      <QualityRow
                        hq={false}
                        dist={dist()}
                        minListing={stats()!.nqMinListing}
                        selectable={canBeHqItem()}
                      />
                    )}
                  </Show>
                  <Show when={stats()?.hqDist}>
                    {(dist) => (
                      <QualityRow
                        hq
                        dist={dist()}
                        minListing={stats()!.hqMinListing}
                        selectable={canBeHqItem()}
                      />
                    )}
                  </Show>
                </div>
              </Show>
            </div>

            {/* 日销量 + 挂单数（次要信息） */}
            <div class="flex shrink-0 gap-8 sm:flex-col sm:gap-3 sm:pl-6">
              <div>
                <div class="text-xs font-medium text-muted-foreground">日销量</div>
                <div class="mt-1 space-y-1 text-sm tabular-nums">
                  <Show when={stats()?.nqVelocity != null && stats()!.nqVelocity > 0}>
                    <div class={'flex items-center gap-1.5 ' + (canBeHqItem() ? qualityRowClass('nq') : '')}>
                      <QualityTag hq={false} />
                      <span class="font-medium">{formatDailySales(stats()!.nqVelocity)}</span>
                    </div>
                  </Show>
                  <Show when={stats()?.hqVelocity != null && stats()!.hqVelocity > 0}>
                    <div class={'flex items-center gap-1.5 ' + (canBeHqItem() ? qualityRowClass('hq') : '')}>
                      <QualityTag hq />
                      <span class="font-medium">{formatDailySales(stats()!.hqVelocity)}</span>
                    </div>
                  </Show>
                  <Show when={(stats()?.nqVelocity ?? 0) === 0 && (stats()?.hqVelocity ?? 0) === 0}>
                    {/* 已加载但销量为 0（非加载中），用 tooltip 说明避免歧义 */}
                    <Tooltip>
                      <TooltipTrigger class="text-muted-foreground cursor-default" aria-label="近期无成交记录">
                        -
                      </TooltipTrigger>
                      <TooltipPortal>
                        <TooltipContent>近期无成交记录</TooltipContent>
                      </TooltipPortal>
                    </Tooltip>
                  </Show>
                </div>
              </div>
              <div>
                <div class="text-xs font-medium text-muted-foreground">挂单数</div>
                <div class="mt-1 flex items-baseline gap-2">
                  <span class="text-sm font-semibold tabular-nums">
                    {stats()?.listingCount.toLocaleString('zh-CN')}
                  </span>
                  <Show when={stats()?.lastUploadTime}>
                    <span class="text-xs text-muted-foreground">
                      {formatTime(stats()?.lastUploadTime ?? 0)}更新
                    </span>
                  </Show>
                </div>
              </div>
            </div>
            </div>
          </CardContent>
        </Card>
      </Show>

      {/* 失败时整区隐藏（错误由统计卡统一呈现）；加载成功但无挂单时
          卡片保留、内容提示无数据，避免页面结构跳动 */}
      <Show when={props.market.data === undefined && !props.market.error}>
        <ListingChartSkeleton />
      </Show>
      <Show when={props.market.data !== undefined}>
        <Card class="mb-6 overflow-hidden py-3" data-report-section="listing-distribution">
          <CardHeader class="pb-2">
            <div class="flex flex-row items-start justify-between gap-4">
            <div>
              <CardTitle class="text-sm">挂单与成交分布</CardTitle>
              <CardDescription class="text-xs">各服务器挂单区间与近 30 天成交区间</CardDescription>
            </div>
            {/* 图例：统计卡与图表共用同一套小图形，不占表格行空间 */}
            <DistributionLegend hidden={hiddenSeries()} onToggle={toggleSeries} class="hidden shrink-0 flex-wrap items-center justify-end gap-x-3 gap-y-1 pt-0.5 text-[10px] text-muted-foreground sm:flex" />
            </div>
          </CardHeader>
          <CardContent class="pt-0">
            <Show
              when={filteredListings().length > 0}
              fallback={
                <EmptyState
                  class="py-8"
                  title="暂无挂单数据"
                  description="该物品在当前范围内没有挂单"
                />
              }
            >
              <ServerListingBarChart directory={directory()} listings={filteredListings()} history={filteredHistory()} scope={scope()} historyLoading={props.history.data === undefined && !props.history.error} historyError={props.history.data === undefined && Boolean(props.history.error)} hidden={hiddenSeries()} />
            </Show>
          </CardContent>
        </Card>
      </Show>

      {/* 历史数据面的错误落点集中在此（成交历史 Tab 不再重复呈现）；
          加载成功但无成交时卡片保留、内容提示无数据 */}
      <Show
        when={props.history.data !== undefined}
        fallback={
          <Show
            when={!props.history.error}
            fallback={
              <ChartErrorCard
                title="历史成交加载失败"
                description={props.history.error ?? undefined}
                loading={props.history.loading}
                onRetry={() => props.history.retry?.()}
              />
            }
          >
            <ListingChartSkeleton />
          </Show>
        }
      >
        <Card class="mb-6 py-3" data-report-section="history-trend">
          <CardHeader class="pb-2">
            <CardTitle class="text-sm">交易走势</CardTitle>
            <CardDescription class="text-xs">按服务器拆分的成交记录可视化</CardDescription>
          </CardHeader>
          <CardContent class="pt-0">
            <Show
              when={filteredHistory().length > 0}
              fallback={
                <EmptyState
                  class="py-8"
                  title="暂无成交记录"
                  description="该物品在当前范围内近期没有成交记录"
                />
              }
            >
              <Tabs value={historyChartTab()} onChange={setHistoryChartTab}>
                <TabsList class="mb-4">
                  <TabsTrigger value="line">走势</TabsTrigger>
                  <TabsTrigger value="scatter">散点</TabsTrigger>
                </TabsList>
                <TabsContent value="line">
                  <ServerHistoryTrendChart animate={props.animateCharts} history={filteredHistory()} />
                </TabsContent>
                <TabsContent value="scatter">
                  <ServerHistoryScatterChart animate={props.animateCharts} directory={directory()} history={filteredHistory()} scope={scope()} />
                </TabsContent>
              </Tabs>
            </Show>
          </CardContent>
        </Card>
      </Show>

      <Show when={props.showDetails !== false}>
        <div>
          <Tabs value={activeTab()} onChange={setActiveTab}>
            <TabsList class="mb-4">
              <TabsTrigger value="listings">当前挂单</TabsTrigger>
              <TabsTrigger value="history">成交历史</TabsTrigger>
            </TabsList>

            <TabsContent value="listings">
              {/* 无数据错误由统计卡统一呈现，本区域只在加载中或加载成功时渲染 */}
              <Show when={props.market.data !== undefined || !props.market.error}>
                <Card class="py-3">
                  <CardHeader class="pb-2">
                    <CardTitle class="text-sm">当前挂单</CardTitle>
                    <CardDescription class="text-xs">
                      <Show when={props.market.data !== undefined} fallback="正在加载挂单数据">
                        共 {filteredListings().length} 个挂单
                      </Show>
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="pt-0">
                    <Show
                      when={props.market.data !== undefined}
                      fallback={<ListingTableSkeleton />}
                    >
                      <Show
                        when={filteredListings().length > 0}
                        fallback={
                          <EmptyState
                            title="暂无挂单数据"
                            description="该物品在当前区域暂无挂单信息"
                          />
                        }
                      >
                        <Table>
                          <TableHeader>
                            <TableRow class="hover:bg-transparent">
                              <TableHead>品质</TableHead>
                              <TableHead>单价</TableHead>
                              <TableHead>数量</TableHead>
                              <TableHead>总价</TableHead>
                              <TableHead>服务器</TableHead>
                              <TableHead>雇员</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <For each={filteredListings().slice(0, 50)}>
                              {(listing) => (
                                <TableRow>
                                  <TableCell>
                                    <QualityTag hq={listing.hq} />
                                  </TableCell>
                                  <TableCell class="font-medium">
                                    {formatGil(listing.pricePerUnit)} Gil
                                  </TableCell>
                                  <TableCell>{listing.quantity}</TableCell>
                                  <TableCell class="font-medium">
                                    {formatGil(listing.total)} Gil
                                  </TableCell>
                                  <TableCell class="text-muted-foreground">
                                    <WorldBadge directory={directory()} worldName={listing.worldName || scope()} />
                                  </TableCell>
                                  <TableCell class="text-muted-foreground">
                                    {listing.retainerName}
                                  </TableCell>
                                </TableRow>
                              )}
                            </For>
                          </TableBody>
                        </Table>
                      </Show>
                    </Show>
                  </CardContent>
                </Card>
              </Show>
            </TabsContent>

            <TabsContent value="history">
              {/* 无数据错误由上方走势图区域统一呈现，本区域只在加载中或加载成功时渲染 */}
              <Show when={props.history.data !== undefined || !props.history.error}>
                <Card class="py-3">
                  <CardHeader class="pb-2">
                    <CardTitle class="text-sm">成交历史</CardTitle>
                    <CardDescription class="text-xs">
                      <Show when={props.history.data !== undefined} fallback="正在加载成交记录">
                        近期 {filteredHistory().length} 笔成交记录
                      </Show>
                    </CardDescription>
                  </CardHeader>
                  <CardContent class="pt-0">
                    <Show
                      when={props.history.data !== undefined}
                      fallback={
                        <div role="status">
                          <span class="sr-only">加载中</span>
                          <Skeleton class="h-[400px]" />
                        </div>
                      }
                    >
                      <Show
                        when={filteredHistory().length > 0}
                        fallback={
                          <EmptyState
                            title="暂无历史数据"
                            description="该物品在当前区域暂无历史成交记录"
                          />
                        }
                      >
                        <Table>
                          <TableHeader>
                            <TableRow class="hover:bg-transparent">
                              <TableHead>品质</TableHead>
                              <TableHead>单价</TableHead>
                              <TableHead>数量</TableHead>
                              <TableHead>总价</TableHead>
                              <TableHead>买家</TableHead>
                              <Show when={showHistoryWorld()}>
                                <TableHead>服务器</TableHead>
                              </Show>
                              <TableHead>时间</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            <For each={filteredHistory().slice(0, 30)}>
                              {(sale) => (
                                <TableRow>
                                  <TableCell>
                                    <QualityTag hq={sale.hq} />
                                  </TableCell>
                                  <TableCell class="font-medium">
                                    {formatGil(sale.pricePerUnit)} Gil
                                  </TableCell>
                                  <TableCell>{sale.quantity}</TableCell>
                                  <TableCell class="font-medium">
                                    {formatGil(sale.total)} Gil
                                  </TableCell>
                                  <TableCell class="text-muted-foreground">
                                    {sale.buyerName || '-'}
                                  </TableCell>
                                  <Show when={showHistoryWorld()}>
                                    <TableCell class="text-muted-foreground">
                                      <WorldBadge directory={directory()} worldName={sale.worldName} />
                                    </TableCell>
                                  </Show>
                                  <TableCell class="text-muted-foreground text-xs">
                                    {new Date(sale.timestamp * 1000).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                  </TableCell>
                                </TableRow>
                              )}
                            </For>
                          </TableBody>
                        </Table>
                      </Show>
                    </Show>
                  </CardContent>
                </Card>
              </Show>
            </TabsContent>
          </Tabs>
        </div>
      </Show>
    </div>
  )
}
