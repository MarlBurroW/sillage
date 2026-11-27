import { execSync } from 'node:child_process'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

const SERVER_PORT = process.env.SILLAGE_PORT ?? '7317'

// Same resolution as apps/server/tsup.config.ts: release CI tag, git describe for local builds,
// `dev` outside a repository.
function resolveVersion(): string {
  if (process.env.SILLAGE_VERSION) return process.env.SILLAGE_VERSION.replace(/^v/, '')
  try {
    return execSync('git describe --tags --always --dirty', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

const APP_VERSION = resolveVersion()
const BUILD_TIME = new Date().toISOString()

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      /*
       * Lets a page still running the previous build name the version it is about to load: the
       * update prompt reads it once a new service worker is waiting. Left out of the precache
       * (json is not in `globPatterns`) and served `no-cache`, so it always reflects the deployed
       * build.
       */
      name: 'sillage-version-file',
      apply: 'build',
      generateBundle() {
        this.emitFile({
          type: 'asset',
          fileName: 'version.json',
          source: JSON.stringify({ version: APP_VERSION, builtAt: BUILD_TIME }),
        })
      },
    },
    VitePWA({
      /*
       * Use `prompt` rather than `autoUpdate`. Automatic updates give the new service worker
       * control but leave loaded pages running old code without notice or reload. Installed PWAs
       * resuming from memory could remain outdated indefinitely. Prompt mode notifies the app and
       * offers reload; forced reload would lose a message being composed.
       */
      registerType: 'prompt',
      // Register from the app, which needs `useRegisterSW` feedback to display the prompt.
      injectRegister: null,
      // Copy `push-sw.js` unchanged: the generated bundle does not import it; the service worker
      // loads it at runtime.
      includeAssets: ['apple-touch-icon.png', 'favicon.svg', 'push-sw.js'],
      manifest: {
        name: 'Sillage',
        short_name: 'Sillage',
        description: 'Plateforme de développement agentique self-hosted et multi-CLI',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait-primary',
        background_color: '#0b0d1c',
        theme_color: '#0b0d1c',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
          // `maskable` reserves Android's cropped region: otherwise circular icon cropping hides the symbol.
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Load push listeners into the generated service worker instead of writing it entirely by
        // hand, preserving Workbox precache management.
        importScripts: ['/push-sw.js'],
        // Precache the app shell, never API responses, which would make the thread inconsistent
        // with the log (invariant I2).
        globPatterns: ['**/*.{js,css,html,woff2}'],
        // Optional Fontsource families (lib/fonts.ts): precaching every script of every family would
        // push megabytes to each client for fonts most never pick. They are cached once used instead.
        globIgnores: ['**/*-wght-normal-*.woff2'],
        // The main bundle still exceeds the default 2 MiB limit (2.14 MB on October 17, 2026), even
        // after lazy-loading the French catalog, which accounted for under 190 KB of 2.33 MB. It is
        // downloaded at startup anyway; excluding it only breaks offline use. Returning to the
        // default limit requires further bundle reduction.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/s\//],
        runtimeCaching: [
          { urlPattern: /^\/api\//, handler: 'NetworkOnly' },
          // Hashed file names: a cached copy is never stale, and the chosen font keeps working offline.
          { urlPattern: /\/assets\/.*-wght-normal-.*\.woff2$/, handler: 'CacheFirst', options: { cacheName: 'sillage-fonts' } },
        ],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5317,
    proxy: {
      '/s/': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: false,
      },
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        // The server compares browser Origin with Host, including Vite's port.
        changeOrigin: false,
        ws: true,
      },
    },
  },
  /**
   * Build identifier displayed in settings. Without it, reports of missing fixes cannot be resolved
   * because the screen gives no evidence of the running version.
   */
  define: {
    __BUILD_TIME__: JSON.stringify(BUILD_TIME),
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
