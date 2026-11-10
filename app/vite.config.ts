import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { execSync } from 'child_process'
import { defineConfig, loadEnv } from 'vite'
import solid from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { resolveSiteTarget } from './site-target'

function getGitInfo() {
  try {
    const commit = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim()
    const subject = execSync('git log -1 --format=%s', { encoding: 'utf-8' }).trim()
    const date = execSync('git log -1 --format=%cI', { encoding: 'utf-8' }).trim()
    return { commit, subject, date }
  } catch {
    return { commit: 'unknown', subject: '', date: '' }
  }
}

const itemsSource = JSON.parse(readFileSync(new URL('./.generated/items-source.json', import.meta.url), 'utf-8'))
const gitCommit = getGitInfo()
const base = (process.env.BASE_URL || '/').replace(/\/?$/, '/')

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_SITE_TARGET')
  const siteTarget = resolveSiteTarget(env.VITE_SITE_TARGET)

  return {
    base,
    plugins: [solid(), tailwindcss()],
    build: {
      rolldownOptions: {
        input: {
          app: fileURLToPath(new URL('./index.html', import.meta.url)),
          render: fileURLToPath(new URL('./render.html', import.meta.url)),
        },
      },
    },
    define: {
      'import.meta.env.VITE_SITE_TARGET': JSON.stringify(siteTarget),
      __BUILD_COMMIT__: JSON.stringify(itemsSource.commit),
      __BUILD_DATE__: JSON.stringify(itemsSource.date),
      __ITEMS_SOURCES__: JSON.stringify([
        { id: 'tos', label: 'TOS', url: itemsSource.url },
        { id: 'github-pages', label: 'GitHub Pages', url: `${base}items/${itemsSource.sha256}.json` },
      ]),
      __ITEMS_SHA256__: JSON.stringify(itemsSource.sha256),
      __ITEMS_SIZE__: JSON.stringify(itemsSource.size),
      __GIT_COMMIT__: JSON.stringify(gitCommit.commit),
      __GIT_COMMIT_SUBJECT__: JSON.stringify(gitCommit.subject),
      __GIT_COMMIT_DATE__: JSON.stringify(gitCommit.date),
    },
    server: {
      proxy: {
        '/api/universalis': {
          target: 'https://universalis.app',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/universalis/, ''),
        },
      },
    },
  }
})
