import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { DEFAULT_CLAUDE_CONFIG } from '@sillage/protocol'
import { ClaudeRunner } from '../src/agents/claude/runner.js'
import type { RunnerContext } from '../src/agents/types.js'

// The real SDK builds command lines; replace only CLIs to verify launch contracts
// without Claude accounts or quota usage.
const cli = `
import { writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
writeFileSync('launch.json', JSON.stringify(process.argv.slice(2)));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.type === 'control_request') {
    process.stdout.write(JSON.stringify({
      type: 'control_response',
      response: { subtype: 'success', request_id: message.request_id,
        response: { commands: [], models: [], agents: [], mcpServers: [] } }
    }) + '\\n');
  }
}
`

for (const mode of ['manual', 'bypassPermissions'] as const) {
  for (const resume of [null, '00000000-0000-4000-8000-000000000001']) {
    test(`Claude : lancement ${mode}, reprise=${Boolean(resume)}`, async (t) => {
      const cwd = await mkdtemp(join(tmpdir(), 'sillage-claude-permissions-'))
      const binary = join(cwd, 'claude.mjs')
      await writeFile(binary, cli)
      const config = { ...DEFAULT_CLAUDE_CONFIG, permissionMode: mode }
      const ctx: RunnerContext = {
        conversationId: 'test', cwd, binary, config, resumeSessionId: resume,
        attachmentsRoot: cwd,
        projectOverview: () => null, maskedInstructionRoots: () => [], memoryDir: () => null,
        resolveMcpServers: () => ({ servers: [], failures: [] }), skillRoots: () => [],
        emit: () => {}, setStatus: () => {}, setAgentSessionId: () => {},
        updateConfig: () => {}, openPermissionRequest: () => 'permission', closePermissionRequest: () => {},
      }
      const runner = new ClaudeRunner(ctx)
      t.after(async () => {
        await runner.stop()
        await rm(cwd, { recursive: true, force: true })
      })
      await runner.start()
      let args: string[] | null = null
      const deadline = Date.now() + 5000
      while (!args && Date.now() < deadline) {
        args = await readFile(join(cwd, 'launch.json'), 'utf8').then(JSON.parse).catch(() => null)
        if (!args) await new Promise((resolve) => setTimeout(resolve, 10))
      }
      assert.ok(args, 'le SDK doit lancer le CLI')
      assert.ok(args.includes(`--permission-mode=${mode === 'manual' ? 'default' : mode}`))
      assert.equal(args.includes('--allow-dangerously-skip-permissions'), mode === 'bypassPermissions')
      assert.equal(args.includes(`--resume=${resume}`), resume !== null)

      // Managers must restart CLIs in both directions: control acknowledgments alone
      // must not imply live application.
      const nextMode = mode === 'manual' ? 'bypassPermissions' : 'manual'
      assert.equal(await runner.applyConfig({ ...config, permissionMode: nextMode }), false)
      assert.equal(runner.appliedConfig.permissionMode, mode)
    })
  }
}
