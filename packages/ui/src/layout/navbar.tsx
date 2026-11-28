import { createEffect, createResource, createSignal, For, lazy, onMount, Show, Suspense } from 'solid-js'
import { A } from '@solidjs/router'
import { selectedRegion, setDataCenters, setWorlds, fetchDataCenters, fetchWorlds, errMessage, setWorldsLoadFailed } from '@xiv-market/shared'
import { BuildCommitLink } from './build-badge'

const RegionSelect = lazy(() => import('./region-select'))

const navLinkClass =
  'whitespace-nowrap transition-colors text-foreground/60 hover:text-foreground'
const navLinkMobileHiddenClass = `${navLinkClass} hidden sm:inline-block`

export function Navbar(props: {
  logoUrl: string
  navItems?: { href: string; label: string; end?: boolean; hideOnMobile?: boolean }[]
  variant?: 'pro'
  githubUrl?: string
  homeUrl?: string
}) {
  const variant = () => props.variant

  const isPro = () => variant() === 'pro'

  const badgeClass = () => 'bg-[rgba(245,158,11,0.15)] text-[#d97706] border-[rgba(245,158,11,0.25)]'
  const [showRegionSelect, setShowRegionSelect] = createSignal(false)

  // 大区/服务器列表失败时静默降级：RegionSelect 用硬编码区域列表、
  // WorldBadge 退化为纯文本，功能仍可用，不打断用户（仅 console 留痕）。
  // 同时置 worldsLoadFailed，让 ItemDetail 从"骨架等待"转为"降级不过滤"。
  // fetcher 不抛出，避免 Solid 1.9 读取 errored resource 时 throw
  const [dataCentersRes] = createResource(() =>
    fetchDataCenters()
      .then((d) => {
        // 空列表等同失败（Universalis 不会合法返回空），走降级而非让页面永久等待
        if (!d.length) throw new Error('数据中心列表为空')
        return d
      })
      .catch((e) => {
        console.warn('[Navbar] %s', errMessage(e))
        setWorldsLoadFailed(true)
        return null
      })
  )
  const [worldsRes] = createResource(() =>
    fetchWorlds()
      .then((d) => {
        if (!d.length) throw new Error('服务器列表为空')
        return d
      })
      .catch((e) => {
        console.warn('[Navbar] %s', errMessage(e))
        setWorldsLoadFailed(true)
        return null
      })
  )

  onMount(() => {
    const win = window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }
    if (win.requestIdleCallback) {
      win.requestIdleCallback(() => setShowRegionSelect(true), { timeout: 1000 })
      return
    }
    window.setTimeout(() => setShowRegionSelect(true), 250)
  })

  createEffect(() => {
    if (dataCentersRes()) setDataCenters(dataCentersRes()!)
  })

  createEffect(() => {
    if (worldsRes()) setWorlds(worldsRes()!)
  })

  return (
    <header class="sticky top-0 z-50 w-full border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div class="flex h-14 max-w-7xl mx-auto items-center px-4 sm:px-6 lg:px-8">
        {/* 左：IceXIV 首页；右：本市场首页。两个独立入口，中间竖线分隔。 */}
        <a
          href={props.homeUrl ?? 'https://icexiv.github.io/'}
          class="flex items-center gap-2 transition-opacity hover:opacity-70 sm:gap-2.5"
          aria-label="IceXIV 首页"
          title="IceXIV"
        >
          <svg viewBox="0 0 30 32" fill="none" aria-hidden="true" class="h-6 w-[22px] shrink-0 sm:h-7 sm:w-[26px]">
            <path d="M15 1 27.5 8.2 15 15.4 2.5 8.2Z" fill="#9dc8ea"/>
            <path d="m2.5 10.7 11 6.35v13L2.5 23.7Z" fill="#4a85bb"/>
            <path d="m16.5 17.05 11-6.35v13l-11 6.35Z" fill="#76acd5"/>
            <path d="m15 5.8 4.3 2.4-4.3 2.5-4.3-2.5Z" fill="#fff" fill-opacity=".8"/>
          </svg>
          <span class="hidden text-sm font-medium tracking-tight text-foreground sm:inline">IceXIV</span>
        </a>
        <span class="mx-2 h-5 w-px shrink-0 bg-border sm:mx-3" aria-hidden="true" />
        <A href="/" class="mr-3 flex shrink-0 items-center gap-2 transition-opacity hover:opacity-70 sm:mr-6">
          <img src={props.logoUrl} width="32" height="32" alt="" class="size-7 shrink-0 object-contain sm:size-8" />
          <span class="hidden text-base font-semibold tracking-tight text-foreground min-[400px]:inline">Market</span>
          {isPro() && (
            <span class={`inline-flex items-center rounded px-1.5 py-0.5 text-xs font-semibold uppercase tracking-wider border ${badgeClass()}`}>
              {variant()}
            </span>
          )}
        </A>

        <nav class="flex shrink-0 items-center space-x-4 text-sm font-medium sm:space-x-6" aria-label="主导航">
          <For each={props.navItems ?? []}>
            {(item) => (
              <A
                href={item.href}
                class={item.hideOnMobile ? navLinkMobileHiddenClass : navLinkClass}
                activeClass="text-foreground"
                end={item.end}
              >
                {item.label}
              </A>
            )}
          </For>
        </nav>

        <div class="flex flex-1 items-center justify-end space-x-3">
          <div class="flex items-center space-x-2">
            <label for="region-select" class="hidden shrink-0 whitespace-nowrap text-sm text-muted-foreground md:inline">
              区域
            </label>
            <Show
              when={showRegionSelect()}
              fallback={
                <span class="inline-flex h-8 min-w-16 items-center rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs">
                  {selectedRegion()}
                </span>
              }
            >
              <Suspense
                fallback={
                  <span class="inline-flex h-8 min-w-16 items-center rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs">
                    {selectedRegion()}
                  </span>
                }
              >
                <RegionSelect />
              </Suspense>
            </Show>
          </div>

          {props.githubUrl && (
            <a
              href={props.githubUrl}
              target="_blank"
              rel="noopener noreferrer"
              class="hidden h-8 w-8 items-center justify-center rounded-lg border border-input bg-background text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground sm:inline-flex"
              aria-label="GitHub"
              title="GitHub"
            >
              <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
                <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/>
                <path d="M9 18c-4.51 2-5-2-7-2"/>
              </svg>
            </a>
          )}

          <BuildCommitLink />

          <A
            href="/settings"
            class="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-input bg-background text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            activeClass="bg-accent text-accent-foreground"
            end
              aria-label="设置"
              title="设置"
          >
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="h-4 w-4">
              <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l-.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
              <circle cx="12" cy="12" r="3"/>
            </svg>
          </A>
        </div>
      </div>
    </header>
  )
}
