import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { agentRequests, openDatabase, runMigrations } from '@sillage/db'
import {
  ALWAYS_ON_SILLAGE_TOOLS,
  CARD_RELATION_INVERSE,
  SILLAGE_TOOL_FAMILIES,
  CARD_TAG_NAME_MAX,
  CARD_TAGS_PER_CARD_MAX,
  CHECK_SKIP_EXIT_CODE,
  DEFAULT_CHECK_TIMEOUT_SECONDS,
  DEFAULT_SCHEDULE_DURATION_MINUTES,
  MAX_CHECK_SCRIPT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_MEMORY_FILE_CHARS,
  MAX_PROJECT_IMAGE_BYTES,
  MAX_SCHEDULE_PROMPT_CHARS,
  MAX_SESSION_TITLE_CHARS,
  MEMORY_INDEX_FILE,
  REPO_INSTRUCTION_FILES,
  cardRelationKindSchema,
  memoryFileSchema,
  sessionReference,
} from '@sillage/protocol'
import { MAX_LAUNCH_PROMPT_CHARS, MIN_AGENT_SCHEDULE_MINUTES } from '../src/sessions/agent-requests.js'
import { MAX_HOPS, WAKES_PER_HOUR } from '../src/sessions/session-relay.js'
import { TOOL_FAMILY_OFF } from '../src/agents/agent-tools.js'

/**
 * `sillage-mcp.mjs` runs as a standalone process, outside the module graph: it cannot import
 * protocol constants nor Drizzle tables, so it copies the first and writes raw SQL against the
 * second. Nothing compiled it against either. These tests read its source and hold it to both:
 * a renamed column or a changed limit fails here instead of as a tool error in an agent's turn.
 */

const SCRIPT = fileURLToPath(new URL('../src/mcp/sillage-mcp.mjs', import.meta.url))
const source = ts.createSourceFile(SCRIPT, await readFile(SCRIPT, 'utf8'), ts.ScriptTarget.Latest, true)

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node)
  ts.forEachChild(node, (child) => walk(child, visit))
}

/** Value of a top-level `const NAME = <literal expression>`. */
function topLevel(name: string): unknown {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) {
        // Literals only (numbers, strings, regexes, arrays, arithmetic): no identifiers to resolve.
        return new Function(`return (${declaration.initializer.getText()})`)()
      }
    }
  }
  throw new Error(`No top-level const ${name} in sillage-mcp.mjs`)
}

test('constants copied by the MCP server agree with the protocol and the daemon', () => {
  const copies: [string, unknown][] = [
    ['MAX_LAUNCH_PROMPT_CHARS', MAX_LAUNCH_PROMPT_CHARS],
    ['MAX_SESSION_TITLE_CHARS', MAX_SESSION_TITLE_CHARS],
    ['MAX_SCHEDULE_PROMPT_CHARS', MAX_SCHEDULE_PROMPT_CHARS],
    ['DEFAULT_SCHEDULE_DURATION_MINUTES', DEFAULT_SCHEDULE_DURATION_MINUTES],
    ['MIN_AGENT_SCHEDULE_MINUTES', MIN_AGENT_SCHEDULE_MINUTES],
    ['CHECK_SKIP_EXIT_CODE', CHECK_SKIP_EXIT_CODE],
    ['MAX_CHECK_SCRIPT_CHARS', MAX_CHECK_SCRIPT_CHARS],
    ['DEFAULT_CHECK_TIMEOUT_SECONDS', DEFAULT_CHECK_TIMEOUT_SECONDS],
    ['MAX_HOPS', MAX_HOPS],
    ['WAKES_PER_HOUR', WAKES_PER_HOUR],
    ['MAX_PROJECT_IMAGE_BYTES', MAX_PROJECT_IMAGE_BYTES],
    ['MAX_INSTRUCTIONS_CHARS', MAX_INSTRUCTIONS_CHARS],
    ['MEMORY_INDEX', MEMORY_INDEX_FILE],
    ['MAX_MEMORY_FILE_CHARS', MAX_MEMORY_FILE_CHARS],
    ['REPO_INSTRUCTION_FILES', [...REPO_INSTRUCTION_FILES]],
  ]
  for (const [name, expected] of copies) assert.deepEqual(topLevel(name), expected, name)

  // The memory file pattern: same accepted and refused names as the protocol schema.
  const pattern = topLevel('MEMORY_FILE_PATTERN') as RegExp
  for (const file of ['notes.md', 'a.b-c_d.md', '.hidden.md', 'no-extension', 'dir/notes.md', `${'x'.repeat(121)}.md`, `${'x'.repeat(122)}.md`]) {
    assert.equal(pattern.test(file), memoryFileSchema.safeParse(file).success, file)
  }
  assert.equal(new Function(`return (${findArrow('sessionReference')})`)()('abc'), sessionReference('abc'))

  // Card tag limits are stated in a tool description.
  const tags = topLevel('TAGS_PARAM') as { description: string }
  assert.match(tags.description, new RegExp(`at most ${CARD_TAGS_PER_CARD_MAX}, each at most ${CARD_TAG_NAME_MAX} characters`))
})

function findArrow(name: string): string {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const declaration = statement.declarationList.declarations[0]
    if (declaration && ts.isIdentifier(declaration.name) && declaration.name.text === name && declaration.initializer) return declaration.initializer.getText()
  }
  throw new Error(`No top-level ${name} in sillage-mcp.mjs`)
}

test('card relation kinds and labels in the MCP server agree with the protocol', () => {
  const kinds = cardRelationKindSchema.options as readonly string[]
  const enums: string[][] = []
  let labels: Record<string, [string, string]> | null = null
  walk(source, (node) => {
    if (ts.isArrayLiteralExpression(node) && node.elements.some((element) => ts.isStringLiteral(element) && element.text === 'blocked_by')) {
      enums.push(node.elements.map((element) => (element as ts.StringLiteral).text))
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'labels' && node.initializer?.getText().includes('Blocked by')) {
      labels = new Function(`return (${node.initializer!.getText()})`)() as Record<string, [string, string]>
    }
  })
  assert.ok(enums.length > 0)
  for (const values of enums) assert.deepEqual(values, [...kinds])
  assert.ok(labels)
  // One label pair per stored direction, the other direction being its inverse.
  for (const kind of Object.keys(labels)) {
    assert.ok(kinds.includes(kind), kind)
    assert.ok(Object.keys(labels).includes(kind) && !Object.keys(labels).includes(CARD_RELATION_INVERSE[kind as keyof typeof CARD_RELATION_INVERSE]) || kind === 'related', kind)
  }
  const covered = new Set(Object.keys(labels).flatMap((kind) => [kind, CARD_RELATION_INVERSE[kind as keyof typeof CARD_RELATION_INVERSE]]))
  assert.deepEqual([...covered].sort(), [...kinds].sort())
})

/** Kinds the MCP server can deposit in `agent_requests`: literal arguments of `requestDaemon`, or the tool names its enclosing condition admits. */
function requestedKinds(): Set<string> {
  const kinds = new Set<string>()
  // Tool entries reference other constants: read their `name` properties rather than evaluate them.
  const personalTools: string[] = []
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const declaration = statement.declarationList.declarations[0]
    if (!declaration || declaration.name.getText() !== 'PERSONAL_TOOLS' || !declaration.initializer || !ts.isArrayLiteralExpression(declaration.initializer)) continue
    for (const element of declaration.initializer.elements) {
      if (!ts.isObjectLiteralExpression(element)) continue
      for (const property of element.properties) {
        if (ts.isPropertyAssignment(property) && property.name.getText() === 'name' && ts.isStringLiteral(property.initializer)) personalTools.push(property.initializer.text)
      }
    }
  }
  assert.ok(personalTools.length > 0, 'PERSONAL_TOOLS not found')
  const literals = (node: ts.Node) => {
    walk(node, (inner) => {
      if (ts.isBinaryExpression(inner) && inner.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken &&
        inner.left.getText() === 'name' && ts.isStringLiteral(inner.right)) kinds.add(inner.right.text)
    })
  }
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || node.expression.getText() !== 'requestDaemon') return
    const [kind] = node.arguments
    if (!kind) return
    // A literal, or a choice between literals: the condition's own strings are tool names, not kinds.
    const outcomes = ts.isConditionalExpression(kind) ? [kind.whenTrue, kind.whenFalse] : [kind]
    for (const outcome of outcomes) if (ts.isStringLiteral(outcome)) kinds.add(outcome.text)
    if (kind.getText() !== 'name') return
    let parent: ts.Node | undefined = node.parent
    while (parent && !ts.isIfStatement(parent)) parent = parent.parent
    assert.ok(parent, 'requestDaemon(name) outside an if: its kinds cannot be read')
    const condition = (parent as ts.IfStatement).expression
    if (condition.getText().includes('PERSONAL_TOOLS')) personalTools.forEach((tool) => kinds.add(tool))
    else literals(condition)
  })
  return kinds
}

test('every request kind the MCP server sends is one the daemon handles, and none is dead', () => {
  const sent = requestedKinds()
  const known = new Set<string>(agentRequests.kind.enumValues)
  for (const kind of sent) assert.ok(known.has(kind), `sillage-mcp.mjs sends “${kind}”, absent from agent_requests.kind`)
  // Written by the scheduler, already settled: never sent by the MCP server.
  known.delete('webhook_launch')
  for (const kind of known) assert.ok(sent.has(kind), `agent_requests.kind lists “${kind}”, which sillage-mcp.mjs never sends`)
})

/**
 * Interpolations met in the script's SQL, by their source text, replaced with SQL that keeps the
 * statement valid. A new one fails the test until it is added here: guessing would hide errors.
 */
const INTERPOLATIONS: Record<string, string> = {
  columns: 'id',
  placeholders: '?',
  'cardIds.map(() => \'?\').join(\',\')': '?',
  'DIGEST_TYPES.map(() => \'?\').join(\', \')': '?',
  "scope.personal ? ' OR c.project_id IS NULL' : ''": '',
  'scope.sql': '1',
  "filters.join(' AND ')": '1',
  'WORK_LOG_MAX_SESSIONS + 1': '1',
  EDIT_ROW_LIMIT: '1',
  PEER_HISTORY_LIMIT: '1',
  DIGEST_WINDOW: '1',
}

test('every SQL statement of the MCP server prepares against the migrated schema', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sillage-mcp-sql-'))
  const { db, sqlite } = openDatabase(join(dir, 'test.db'))
  t.after(async () => { sqlite.close(); await rm(dir, { recursive: true, force: true }) })
  runMigrations(db, fileURLToPath(new URL('../../../packages/db/migrations', import.meta.url)))

  const statements: { line: number; sql: string }[] = []
  walk(source, (node) => {
    if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'prepare') return
    const [arg] = node.arguments
    const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1
    if (!arg) return
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      statements.push({ line, sql: arg.text })
    } else if (ts.isTemplateExpression(arg)) {
      let sql = arg.head.text
      for (const span of arg.templateSpans) {
        const expression = span.expression.getText()
        const replacement = expression === 'WORKING' ? String(topLevel('WORKING')) : INTERPOLATIONS[expression]
        assert.ok(replacement !== undefined, `line ${line}: unknown interpolation \${${expression}}, add it to INTERPOLATIONS`)
        sql += replacement + span.literal.text
      }
      statements.push({ line, sql })
    } else {
      assert.fail(`line ${line}: prepare() of a non-literal: ${arg.getText().slice(0, 80)}`)
    }
  })
  assert.ok(statements.length >= 70, `only ${statements.length} statements found`)
  const failures: string[] = []
  for (const { line, sql } of statements) {
    try { sqlite.prepare(sql) } catch (err) { failures.push(`line ${line}: ${(err as Error).message}`) }
  }
  assert.deepEqual(failures, [])

  // `scope.sql` stood for `conversationScope()` above: check its fragments on their own, on the
  // conversations table its default alias names.
  let fragments = 0
  walk(source, (node) => {
    if (!ts.isFunctionDeclaration(node) || node.name?.text !== 'conversationScope') return
    walk(node, (inner) => {
      if (!ts.isTemplateExpression(inner)) return
      const sql = inner.head.text + inner.templateSpans.map((span) => {
        assert.equal(span.expression.getText(), 'alias')
        return 'c' + span.literal.text
      }).join('')
      sqlite.prepare(`SELECT 1 FROM conversations AS c WHERE ${sql}`)
      fragments++
    })
  })
  assert.equal(fragments, 2)
})

test('every MCP tool belongs to exactly one tool family or stays always on', () => {
  // Tool definitions are object literals with a `name: '…'` property directly under them.
  const names = new Set<string>()
  walk(source, (node) => {
    if (!ts.isObjectLiteralExpression(node)) return
    const name = node.properties.find((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'name')
    const description = node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'description')
    if (name && description && ts.isPropertyAssignment(name) && ts.isStringLiteral(name.initializer) && /^[a-z_]+$/.test(name.initializer.text)) {
      const schema = node.properties.some((property) => ts.isPropertyAssignment(property) && property.name.getText() === 'inputSchema')
      if (schema) names.add(name.initializer.text)
    }
  })
  // The two relation tools share one definition built from their names.
  assert.match(source.getText(), /\['link_cards', 'unlink_cards'\]\.map\(/)
  names.add('link_cards')
  names.add('unlink_cards')
  assert.ok(names.size > 40, `found ${names.size} tools`)
  const placed = [...Object.values(SILLAGE_TOOL_FAMILIES).flat(), ...ALWAYS_ON_SILLAGE_TOOLS]
  assert.deepEqual(placed.filter((tool, index) => placed.indexOf(tool) !== index), [], 'a tool in two places')
  assert.deepEqual([...names].filter((tool) => !placed.includes(tool)).sort(), [], 'tools without a family')
  assert.deepEqual(placed.filter((tool) => !names.has(tool)).sort(), [], 'families naming unknown tools')
  assert.equal(topLevel('TOOL_FAMILY_OFF'), TOOL_FAMILY_OFF)
})
