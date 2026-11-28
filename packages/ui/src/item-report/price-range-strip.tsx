import { createMemo, createSignal, For, Show, onMount, onCleanup } from 'solid-js'
import { formatGil, formatAxisGil } from './format'
import { PROFILE_HEIGHT, rangeBins, profilePath, type PricePoint } from './profile'

// 价格分布的迷你区间条：P25~P75 色带 + P50 中线 + 最低挂单圆点。
// 双条对比时由父级传入共享 domain，保证两条坐标对齐；单条时各自自适应。
export function PriceRangeStrip(props: {
  min?: number
  p25: number
  p50: number
  p75: number
  domain?: { lo: number; hi: number }
  /** 挂单点（价格 + 件数），用于画 P25~P75 的厚度 */
  listingPoints?: PricePoint[]
  /** 成交点（价格 + 件数），画自己的 P25~P75，半幅 */
  salePoints?: PricePoint[]
  saleP25?: number
  saleP50?: number
  saleP75?: number
}) {
  const spanOf = (lo: number, hi: number) => (hi > lo ? hi - lo : Math.max(hi * 0.1, 1))

  const domain = createMemo(() => {
    if (props.domain) return props.domain
    // 成交区间可能落在挂单区间之外，一并纳入
    const lows = [props.min ?? props.p25, props.p25, props.saleP25 ?? 0].filter((v) => v > 0)
    const highs = [props.p75, props.saleP75 ?? 0].filter((v) => v > 0)
    const lo = Math.min(...lows)
    const hi = Math.max(...highs)
    const span = spanOf(lo, hi)
    // 左端只需要一点点余量：最低价本身就在条的最左边，留太多会显得空
    return { lo: Math.max(0, lo - span * 0.05), hi: hi + span * 0.18 }
  })
  const pct = (v: number) =>
    Math.min(100, Math.max(0, ((v - domain().lo) / (domain().hi - domain().lo)) * 100))

  // 标签避让在像素空间进行：百分比阈值在窄条（移动端）下不足以容纳文字会相撞，
  // 在宽条下又会把标签无谓地钉到边缘。量出容器实际宽度后做最小位移去重叠
  let rootRef!: HTMLDivElement
  const [stripWidth, setStripWidth] = createSignal(0)
  onMount(() => {
    const observer = new ResizeObserver((entries) => setStripWidth(entries[0].contentRect.width))
    observer.observe(rootRef)
    onCleanup(() => observer.disconnect())
  })

  // 估算标签像素宽度：标签/数值两行取宽者；CJK ≈ 1em，其余 ≈ 0.6em，外加 4px 余量
  const estimateWidth = (label: string, value: string) => {
    const line = (s: string, fontSize: number) => {
      let w = 0
      for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e7f ? fontSize : fontSize * 0.6
      return w
    }
    return Math.ceil(Math.max(line(label, 9), line(value, 10))) + 4
  }

  const px = (v: number) => (pct(v) / 100) * stripWidth()
  const clampCenter = (center: number, w: number) => {
    if (stripWidth() <= w) return stripWidth() / 2
    return Math.min(Math.max(center, w / 2), stripWidth() - w / 2)
  }
  type StripLabel = {
    label: string
    value: string
    center: number
    idealPct: number
    labelClass: string
    valueClass: string
  }

  // 标签必须待在自己刻度对应的位置：只允许被收进条的左右边界，不允许为了避让而左右平移。
  // 两个标签在真实位置会重叠时返回 null，由调用方降级（去掉 P50 或合并成区间）。
  const trueCenters = (items: { x: number; w: number }[], gap = 6): number[] | null => {
    const width = stripWidth()
    if (width <= 0) return items.map((item) => item.x)
    const centers = items.map((item) => clampCenter(item.x, item.w))
    for (let i = 1; i < centers.length; i++) {
      if (centers[i] - centers[i - 1] < (items[i - 1].w + items[i].w) / 2 + gap) return null
    }
    return centers
  }

  // 一组分位标签：先试三个（P25/P50/P75），重叠就去掉 P50，再重叠就合并成区间
  const buildLabels = (
    entries: { label: string; value: number }[],
    prefix: string,
    labelClass: string,
    valueClass: string,
    droppableFirst = false,
  ): StripLabel[] => {
    if (!entries.length) return []
    const specs = entries.map((entry) => ({
      label: prefix + entry.label,
      value: formatAxisGil(entry.value),
      at: px(entry.value),
      idealPct: pct(entry.value),
      labelClass,
      valueClass,
    }))
    const place = (subset: typeof specs) =>
      trueCenters(subset.map((spec) => ({ x: spec.at, w: estimateWidth(spec.label, spec.value) })))
    // 降级顺序：全部 → 去掉 P50（保留最低价与两端）→ 只留两端 → 合并
    const attempts: (typeof specs)[] = [specs]
    if (specs.length === 4) attempts.push([specs[0], specs[1], specs[3]])
    if (specs.length >= 3) attempts.push([specs[0], specs[specs.length - 1]])
    for (const subset of attempts) {
      const centers = place(subset)
      if (centers) return subset.map((spec, i) => ({ ...spec, center: centers[i] }))
    }
    // 合并成一段区间，位置取两端真实位置的中点
    const first = entries[droppableFirst && entries.length > 2 ? 1 : 0]
    const last = entries[entries.length - 1]
    const equal = first.value === last.value
    const label = `${prefix}${equal ? 'P25=P75' : 'P25~P75'}`
    const value = equal ? formatAxisGil(first.value) : `${formatAxisGil(first.value)}~${formatAxisGil(last.value)}`
    const idealPct = (pct(first.value) + pct(last.value)) / 2
    return [
      {
        label,
        value,
        // 合并标签保持真实位置：贴边时允许略微伸出条外，也不为了塞进条内而右移
        center: px((first.value + last.value) / 2),
        idealPct,
        labelClass,
        valueClass,
      },
    ]
  }

  // 顶部：成交的 P25 / P50 / P75（琥珀），没有成交样本时不显示
  const topLabels = createMemo((): StripLabel[] => {
    const saleP25 = props.saleP25 ?? 0
    const saleP75 = props.saleP75 ?? 0
    if (!(saleP25 > 0) || !(saleP75 > 0)) return []
    const entries = [
      { label: 'P25', value: saleP25 },
      ...(props.saleP50 != null && props.saleP50 > 0 ? [{ label: 'P50', value: props.saleP50 }] : []),
      { label: 'P75', value: saleP75 },
    ]
    return buildLabels(entries, '成交 ', 'text-[9px] text-amber-600', 'text-[10px] font-semibold text-amber-500')
  })

  // 底部：挂单口径统一在下方（最低价 + P25 / P50 / P75），成交在另一侧
  const bottomLabels = createMemo((): StripLabel[] =>
    buildLabels(
      [
        { label: 'P25', value: props.p25 },
        { label: 'P50', value: props.p50 },
        { label: 'P75', value: props.p75 },
      ],
      '',
      'text-[9px] text-muted-foreground',
      'text-[10px] text-muted-foreground',
    ),
  )

  // 最低挂单：位置单独算；与 P25 的标签挤在一起时不显示（左侧大数字仍然给出）
  const minLabel = createMemo(() => {
    if (props.min == null || props.min <= 0) return null
    const width = stripWidth()
    const value = formatAxisGil(props.min)
    const labelWidth = estimateWidth('最低', value)
    const at = px(props.min)
    const p25x = px(props.p25)
    const p25Width = estimateWidth('P25', formatAxisGil(props.p25))
    if (width > 0 && Math.abs(p25x - at) < (labelWidth + p25Width) / 2 + 6) return null
    return { center: clampCenter(at, labelWidth), value }
  })

  // 未测量到宽度时的首帧兜底：按理想百分比 + 边缘锚定落位
  const labelStyle = (l: StripLabel) =>
    stripWidth() > 0
      ? { left: `${l.center}px`, transform: 'translateX(-50%)' }
      : {
          left: `${l.idealPct}%`,
          transform:
            l.idealPct <= 4 ? 'translateX(0)' : l.idealPct >= 96 ? 'translateX(-100%)' : 'translateX(-50%)',
        }

  return (
    <div ref={rootRef} data-layout-ready={stripWidth() > 0 ? "true" : "false"}>
      {/* 成交标签在上，挂单标签（含最低价）在下 */}
      <div class="relative mb-1.5 h-6">
        <For each={topLabels()}>
          {(l) => (
            <span
              class="absolute top-0 flex flex-col items-center gap-0.5 whitespace-nowrap leading-none tabular-nums"
              style={labelStyle(l)}
            >
              <span class={l.labelClass}>{l.label}</span>
              <span class={l.valueClass}>{l.value}</span>
            </span>
          )}
        </For>
      </div>
      <div class="relative h-4 rounded-sm bg-muted/30">
        <svg
          viewBox={`0 0 100 ${PROFILE_HEIGHT}`}
          preserveAspectRatio="none"
          class="absolute inset-0 h-full w-full"
          aria-hidden="true"
        >
          {/* 挂单 P25~P75 整块 */}
          <Show when={props.listingPoints && props.listingPoints.length > 0}>
            <path
              d={profilePath(rangeBins(props.listingPoints!, pct(props.p25), pct(props.p75), pct), pct(props.p25), pct(props.p75), 2 / 3, 'down')}
              class="fill-primary stroke-primary"
              fill-opacity="0.28"
              stroke-opacity="0.28"
              stroke-width="1"
              vector-effect="non-scaling-stroke"
            />
          </Show>
          {/* 成交 P25~P75：实心琥珀，半幅 */}
          <Show when={props.salePoints && props.salePoints.length > 0 && props.saleP25 != null && props.saleP75 != null && props.saleP75! > 0}>
            <path
              d={profilePath(
                rangeBins(props.salePoints!, pct(props.saleP25!), pct(props.saleP75!), pct),
                pct(props.saleP25!),
                pct(props.saleP75!),
                2 / 3,
                'up',
              )}
              class="fill-amber-500 stroke-amber-500"
              stroke-width="1"
              stroke-linejoin="round"
              vector-effect="non-scaling-stroke"
            />
          </Show>
          {/* P50 刻度 */}
          <line
            x1={pct(props.p50)}
            y1={PROFILE_HEIGHT / 2 - 5}
            x2={pct(props.p50)}
            y2={PROFILE_HEIGHT / 2 + 5}
            class="stroke-primary"
            stroke-width="1.5"
            stroke-dasharray="2 2"
            vector-effect="non-scaling-stroke"
          />
          <Show when={props.saleP50 != null && props.saleP50 > 0}>
            <line
              x1={pct(props.saleP50!)}
              y1={PROFILE_HEIGHT / 2 - 5}
              x2={pct(props.saleP50!)}
              y2={PROFILE_HEIGHT / 2 + 5}
              class="stroke-amber-700"
              stroke-width="3"
              stroke-opacity="0.5"
              vector-effect="non-scaling-stroke"
            />
          </Show>
        </svg>
        {/* 最低挂单用点：统计卡里只比位置，不比长度 */}
        <Show when={props.min != null && props.min > 0}>
          <div
            class="absolute top-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary ring-2 ring-card"
            style={{ left: `${pct(props.min!)}%` }}
            title={`最低挂单 ${formatGil(props.min!)} Gil`}
          />
        </Show>
      </div>
      <div class="relative mt-1.5 h-6">
        <Show when={minLabel()}>
          {(label) => (
            <span
              class="absolute top-0 flex flex-col items-center gap-0.5 whitespace-nowrap leading-none tabular-nums"
              style={{ left: `${label().center}px`, transform: 'translateX(-50%)' }}
              title={`最低挂单 ${formatGil(props.min!)} Gil`}
            >
              <span class="text-[9px] text-muted-foreground">最低</span>
              <span class="text-[10px] font-semibold text-foreground">{label().value}</span>
            </span>
          )}
        </Show>
        <For each={bottomLabels()}>
          {(l) => (
            <span
              class="absolute top-0 flex flex-col items-center gap-0.5 whitespace-nowrap leading-none tabular-nums"
              style={labelStyle(l)}
            >
              <span class={l.labelClass}>{l.label}</span>
              <span class={l.valueClass}>{l.value}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  )
}
