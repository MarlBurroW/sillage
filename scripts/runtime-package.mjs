/**
 * The runtime package.json shipped in tarballs, Docker and the Desktop server, shared by
 * `stage-runtime.mjs` and `runtime-lock.mjs`.
 *
 * Direct dependencies carry the exact versions pnpm-lock.yaml resolved, the ones the tests ran
 * against, instead of the caret ranges of apps/server/package.json: `npm install` on ranges
 * shipped whatever was published on tag day, possibly a different set per job. The rest of the
 * tree is frozen by the committed `deploy/runtime/npm-shrinkwrap.json`.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Exact versions of `apps/server` dependencies in pnpm-lock.yaml, peer suffixes removed. */
export function lockedServerVersions(root) {
  // A Windows checkout gives the lockfile CRLF line endings: parse it as LF either way.
  const lock = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8').replace(/\r\n/g, '\n')
  const start = lock.indexOf('\n  apps/server:\n')
  if (start === -1) throw new Error('pnpm-lock.yaml has no apps/server importer')
  const rest = lock.slice(start + 1)
  const next = rest.slice(1).search(/\n {2}\S/)
  const block = next === -1 ? rest : rest.slice(0, next + 1)
  const deps = block.split('\n    dependencies:\n')[1]?.split(/\n {4}\S/)[0] ?? ''
  const versions = {}
  for (const match of deps.matchAll(/^ {6}'?([^':\n]+)'?:\n {8}specifier: [^\n]+\n {8}version: ([^\s(]+)/gm)) {
    versions[match[1]] = match[2]
  }
  return versions
}

export function runtimePackage(root, version) {
  const serverPkg = JSON.parse(readFileSync(join(root, 'apps/server/package.json'), 'utf8'))
  const locked = lockedServerVersions(root)
  const dependencies = {}
  for (const [name, spec] of Object.entries(serverPkg.dependencies)) {
    // Workspace packages are bundled into the server by tsup.
    if (spec.startsWith('workspace:')) continue
    const exact = locked[name]
    if (!exact) throw new Error(`${name} is missing from the apps/server importer of pnpm-lock.yaml: run pnpm install`)
    dependencies[name] = exact
  }
  return {
    name: 'sillage-runtime',
    version,
    private: true,
    type: 'module',
    // Carry the root requirement into the distributed tree: `npm rebuild` or
    // `npm install` under an old Node should report it rather than revealing
    // incompatibility through the first crash.
    engines: { node: '>=22.14' },
    dependencies,
  }
}

export const SHRINKWRAP = 'deploy/runtime/npm-shrinkwrap.json'
