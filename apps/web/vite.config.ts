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

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
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
        // The main bundle still exceeds the default 2 MiB limit (2.14 MB on October 17, 2026), even
        // after lazy-loading the French catalog, which accounted for under 190 KB of 2.33 MB. It is
        // downloaded at startup anyway; excluding it only breaks offline use. Returning to the
        // default limit requires further bundle reduction.
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//, /^\/s\//],
        runtimeCaching: [{ urlPattern: /^\/api\//, handler: 'NetworkOnly' }],
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
        changeOrigin: true,
      },
      '/api': {
        target: `http://127.0.0.1:${SERVER_PORT}`,
        changeOrigin: true,
        ws: true,
      },
    },
  },
  /**
   * Build identifier displayed in settings. Without it, reports of missing fixes cannot be resolved
   * because the screen gives no evidence of the running version.
   */
  define: {
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
    __APP_VERSION__: JSON.stringify(resolveVersion()),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})
