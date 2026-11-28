interface ImportMetaEnv {
  readonly VITE_SITE_TARGET: import('../site-target').SiteTarget
  /** 覆盖 Universalis API 基地址；灰度站用 /api/universalis 走同源反代 */
  readonly VITE_UNIVERSALIS_BASE?: string
}
