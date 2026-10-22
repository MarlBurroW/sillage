import { getQuickJS, type QuickJSWASMModule } from 'quickjs-emscripten'
import { scriptDecisionSchema, type AutomationEvent, type DeliveryReason } from '@sillage/protocol'

/** Optional automation scripts run in QuickJS compiled to WebAssembly. Scripts arrive through the interface, potentially from non-administrators, and process Internet-supplied bodies inside the daemon. `node:vm` provides no isolation (as Node documents), while `isolated-vm` requires native compilation on every platform. QuickJS exposes no networking, files or `process`, and enforces memory and time limits: infinite loops are interrupted and growing arrays fail with 'out of memory'. Create a fresh runtime for each execution because exhausted runtimes may be in an uncertain state and recreation costs a fraction of a millisecond. */

const MEMORY_BYTES = 16 * 1024 * 1024
const STACK_BYTES = 512 * 1024
const TIMEOUT_MS = 100
const MAX_LOG_LINES = 50

let quickjs: Promise<QuickJSWASMModule> | null = null

export interface ScriptOutcome {
  /** Validated decision: null means ignore the call. */
  decision:
    | { kind: 'skip'; reason: string | null }
    | { kind: 'launch'; subject: string | null; vars: Record<string, unknown> }
  /** Script failure code, translated into a sentence by the interface. */
  error: DeliveryReason | null
  /** Raw script return value for the test bench. */
  raw: unknown
  logs: string[]
  durationMs: number
}

/** Turns `export default function (event) { … }` into a global assignment so evaluation works as an ordinary script without a module loader. */
function prepare(source: string): string {
  const rewritten = source.replace(/^\s*export\s+default\s+/m, 'globalThis.__decide = ')
  return rewritten === source ? `${source}\n;globalThis.__decide = globalThis.__decide ?? (typeof decide === 'function' ? decide : undefined)` : rewritten
}

export async function runAutomationScript(source: string, event: AutomationEvent): Promise<ScriptOutcome> {
  quickjs ??= getQuickJS()
  const module = await quickjs
  const runtime = module.newRuntime()
  runtime.setMemoryLimit(MEMORY_BYTES)
  runtime.setMaxStackSize(STACK_BYTES)
  const started = Date.now()
  runtime.setInterruptHandler(() => Date.now() - started > TIMEOUT_MS)
  const vm = runtime.newContext()
  const logs: string[] = []

  const fail = (error: DeliveryReason, raw: unknown = undefined): ScriptOutcome => ({
    decision: { kind: 'skip', reason: null },
    error,
    raw,
    logs,
    durationMs: Date.now() - started,
  })

  try {
    // Surface `console.log` in the test bench: it is the script's only debugger.
    const log = vm.newFunction('log', (...args) => {
      if (logs.length < MAX_LOG_LINES) {
        logs.push(args.map((arg) => {
          const value: unknown = vm.dump(arg)
          return typeof value === 'string' ? value : JSON.stringify(value)
        }).join(' '))
      }
    })
    const consoleObject = vm.newObject()
    vm.setProp(consoleObject, 'log', log)
    vm.setProp(vm.global, 'console', consoleObject)
    log.dispose()
    consoleObject.dispose()

    const input = vm.newString(JSON.stringify(event))
    vm.setProp(vm.global, '__event', input)
    input.dispose()

    const loaded = vm.evalCode(prepare(source), 'automation.js')
    if (loaded.error) {
      const error = describe(vm.dump(loaded.error))
      loaded.error.dispose()
      return fail(error)
    }
    loaded.value.dispose()

    const called = vm.evalCode(
      `if (typeof globalThis.__decide !== 'function') throw new Error('The script must export default a function.');
       const __out = globalThis.__decide(JSON.parse(__event));
       JSON.stringify(__out === undefined ? null : __out)`,
      'call.js',
    )
    if (called.error) {
      const error = describe(vm.dump(called.error))
      called.error.dispose()
      return fail(error)
    }
    const text = vm.getString(called.value)
    called.value.dispose()

    const raw: unknown = text === undefined ? null : JSON.parse(text)
    const parsed = scriptDecisionSchema.safeParse(raw)
    if (!parsed.success) {
      return fail({ code: 'script_contract' }, raw)
    }
    const value = parsed.data
    const durationMs = Date.now() - started
    if (value === null || value === false) {
      return { decision: { kind: 'skip', reason: null }, error: null, raw, logs, durationMs }
    }
    if ('skip' in value) {
      return { decision: { kind: 'skip', reason: value.skip }, error: null, raw, logs, durationMs }
    }
    return {
      decision: {
        kind: 'launch',
        subject: value.subject === undefined ? null : String(value.subject),
        vars: value.vars ?? {},
      },
      error: null,
      raw,
      logs,
      durationMs,
    }
  } finally {
    vm.dispose()
    runtime.dispose()
  }
}

function describe(error: unknown): DeliveryReason {
  if (error && typeof error === 'object' && 'message' in error) {
    const { name, message, stack } = error as { name?: string; message?: string; stack?: string }
    if (message === 'interrupted') return { code: 'script_timeout', params: { ms: TIMEOUT_MS } }
    if (message === 'out of memory') return { code: 'script_memory', params: { mb: MEMORY_BYTES / 1024 / 1024 } }
    const where = stack?.split('\n').find((line) => line.includes('automation.js'))?.trim()
    return { code: 'script_exception', params: { message: `${name ?? 'Error'}: ${message}${where ? ` (${where})` : ''}` } }
  }
  return { code: 'script_exception', params: { message: String(error) } }
}
