import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { resolveBinary } from '../src/agents/cli-binary.js'
import { launchOf, npmShimTarget, sdkExecutable } from '../src/agents/launch.js'

/** Le lanceur que `cmd-shim` écrit pour un CLI en JavaScript, comme `@openai/codex`. */
const NODE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@openai\\codex\\bin\\codex.js" %*',
  '',
].join('\r\n')

/** Le même pour un binaire natif, comme `@anthropic-ai/claude-code` (`bin/claude.exe`). */
const NATIVE_SHIM = [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
  '',
].join('\r\n')

/** Le `npm.cmd` livré avec Node, qui ne vient pas de `cmd-shim`. */
const NPM_CMD = [
  ':: Created by npm, please don\'t edit manually.',
  '@ECHO OFF',
  'SETLOCAL',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '"%NODE_EXE%" "%NPM_CLI_JS%" %*',
  '',
].join('\r\n')

test('un lanceur npm vers un script désigne ce script, pas le node.exe qui le précède', () => {
  assert.equal(
    npmShimTarget('C:\\Users\\a\\AppData\\Roaming\\npm\\codex.cmd', NODE_SHIM),
    'C:\\Users\\a\\AppData\\Roaming\\npm\\node_modules\\@openai\\codex\\bin\\codex.js',
  )
})

test('un lanceur npm vers un binaire natif désigne ce binaire', () => {
  assert.equal(
    npmShimTarget('C:\\prefix\\claude.cmd', NATIVE_SHIM),
    'C:\\prefix\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe',
  )
})

test('le npm.cmd de Node désigne npm-cli.js, pas le calcul de préfixe', () => {
  assert.equal(npmShimTarget('C:\\node\\npm.cmd', NPM_CMD), 'C:\\node\\node_modules\\npm\\bin\\npm-cli.js')
})

test('un script à shebang node sans extension, comme bin/grok, se lance par Node', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-shim-'))
  const shim = join(dir, 'grok.cmd')
  writeFileSync(shim, NODE_SHIM.replace('@openai\\codex\\bin\\codex.js', '@xai-official\\grok\\bin\\grok'))
  const launch = launchOf(shim, 'win32')
  assert.equal(launch.command, process.execPath)
  assert.match(launch.args[0]!, /grok\\bin\\grok$/)
})

test("un lanceur inconnu n'a pas de cible", () => {
  assert.equal(npmShimTarget('C:\\x\\tool.cmd', '@echo off\r\necho bonjour\r\n'), null)
})

test('sous Windows, un script se lance par le Node du serveur et un binaire natif tel quel', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sillage-shim-'))
  const node = join(dir, 'codex.cmd')
  const native = join(dir, 'claude.cmd')
  writeFileSync(node, NODE_SHIM)
  writeFileSync(native, NATIVE_SHIM)

  const script = launchOf(node, 'win32')
  assert.equal(script.command, process.execPath)
  assert.match(script.args[0]!, /codex\.js$/)

  const binary = launchOf(native, 'win32')
  assert.match(binary.command, /claude\.exe$/)
  assert.deepEqual(binary.args, [])

  // Le SDK de Claude lance lui-même un script comme un binaire : il reçoit la cible.
  assert.match(sdkExecutable(node, 'win32'), /codex\.js$/)
  assert.match(sdkExecutable(native, 'win32'), /claude\.exe$/)
})

test("ailleurs que sous Windows, un binaire se lance tel quel, même nommé .cmd", () => {
  assert.deepEqual(launchOf('/usr/local/bin/tool.cmd', 'linux'), { command: '/usr/local/bin/tool.cmd', args: [] })
})

test('sous Windows, la résolution complète le nom par PATHEXT, préfixe de Sillage en tête', () => {
  const present = new Set([
    'C:\\data\\agents\\codex.cmd',
    'C:\\Program Files\\Git\\cmd\\git.exe',
    'C:\\tools\\codex.exe',
  ])
  const env = { Path: 'C:\\tools;C:\\Program Files\\Git\\cmd', PATHEXT: '.COM;.EXE;.BAT;.CMD' }
  const exists = (path: string) => present.has(path)

  // Le lanceur que npm a posé à la racine du préfixe passe avant le binaire du PATH.
  assert.equal(resolveBinary('codex', 'C:\\data\\agents', env, 'win32', exists), 'C:\\data\\agents\\codex.cmd')
  // La clé `Path`, écrite à la Windows, est lue comme `PATH`.
  assert.equal(resolveBinary('git', undefined, env, 'win32', exists), 'C:\\Program Files\\Git\\cmd\\git.exe')
  // Un nom qui porte déjà son extension se cherche tel quel.
  assert.equal(resolveBinary('codex.exe', undefined, env, 'win32', exists), 'C:\\tools\\codex.exe')
  // Un chemin absolu sans extension trouve son .exe.
  assert.equal(resolveBinary('C:\\tools\\codex', undefined, env, 'win32', exists), 'C:\\tools\\codex.exe')
  assert.equal(resolveBinary('absent', 'C:\\data\\agents', env, 'win32', exists), null)
})
