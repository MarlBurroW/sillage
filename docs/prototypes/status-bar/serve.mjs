// Serves the status bar mockup with the web app's own Vite, React and Tailwind, so the page uses
// the app's real stylesheet and components instead of copies that could drift.
import { existsSync, symlinkSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../../..')
const web = resolve(root, 'apps/web')

// Bare imports from this folder (and Vite's dependency pre-bundling, which resolves from the
// root) must find the app's packages: one copy of React, the app's versions of every library.
// This folder's .gitignore keeps the link out of the repository.
const link = resolve(here, 'node_modules')
if (!existsSync(link)) symlinkSync(relative(here, resolve(web, 'node_modules')), link)

const require = createRequire(resolve(web, 'package.json'))
const load = async (name) => {
  const module = await import(pathToFileURL(require.resolve(name)).href)
  return module.default?.default ?? module.default ?? module
}
const { createServer } = await import(pathToFileURL(require.resolve('vite')).href)
const react = await load('@vitejs/plugin-react')
const tailwind = await load('@tailwindcss/vite')

const port = Number(process.env.PORT ?? 7502)
const server = await createServer({
  configFile: false,
  root: here,
  plugins: [react(), tailwind()],
  // The tailnet name lets a phone open it through `tailscale serve`.
  server: { host: '127.0.0.1', port, strictPort: true, allowedHosts: ['marldev.tail710c78.ts.net'], fs: { allow: [root] } },
})
await server.listen()
server.printUrls()
