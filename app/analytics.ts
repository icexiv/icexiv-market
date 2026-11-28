import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Plugin } from 'vite'

export const analyticsPath = '_analytics/tracker.js'

export function medamaAnalytics(siteTarget: string, mode: string): Plugin {
  const enabled = siteTarget === 'cn' && mode === 'production'
  return {
    name: 'market-medama',
    apply: 'build',
    generateBundle() {
      if (enabled) this.emitFile({
        type: 'asset', fileName: analyticsPath,
        source: readFileSync(new URL('../ops/medama/tracker.js', import.meta.url), 'utf8'),
      })
    },
    transformIndexHtml(_html, context) {
      if (!enabled || basename(context.filename) !== 'index.html') return
      return [{
        tag: 'script',
        attrs: { defer: true, src: '/' + analyticsPath, referrerpolicy: 'no-referrer' },
        injectTo: 'head',
      }]
    },
  }
}
