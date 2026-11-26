import assert from 'node:assert/strict'
import { beforeEach, test } from 'node:test'
import { resetStorage } from './helpers/storage'
import {
  WEIGHT,
  field,
  kindField,
  paletteUsageBoosts,
  parsePaletteQuery,
  projectField,
  rankPalette,
  recordPaletteUse,
  scopePalette,
  type PaletteItem,
  type PaletteKind,
  type RankContext,
} from '../src/lib/palette'

beforeEach(resetStorage)

function item(kind: PaletteKind, title: string, projectId: string | null, extra: Partial<PaletteItem> = {}): PaletteItem {
  return {
    key: `${kind}:${projectId ?? '-'}:${title}`,
    kind,
    projectId,
    title,
    icon: null,
    fields: [field(title, 'title', WEIGHT.title)],
    target: { type: 'navigate', to: '/' },
    ...extra,
  }
}

const context: RankContext = { currentProjectId: null, projectOrder: ['p1', 'p2'] }
const titles = (groups: ReturnType<typeof rankPalette>) => groups.map((group) => group.hits.map((hit) => hit.item.title))

test('named entities outrank files that match better', () => {
  // Every repository holds a file resembling the query: score alone let files bury the project.
  const groups = rankPalette([item('file', 'power.ts', 'p2'), item('project', 'Power Rush', 'p1')], 'power', context)
  assert.deepEqual(titles(groups), [['Power Rush'], ['power.ts']])
})

test('context fields narrow results unless they are browsable', () => {
  const conversation = item('conversation', 'Fix login', 'p1', {
    fields: [field('Fix login', 'title', WEIGHT.title), projectField('Nimbus', { browse: true })],
  })
  const file = item('file', 'index.ts', 'p1', {
    fields: [field('index.ts', 'title', WEIGHT.title), projectField('Nimbus')],
  })
  // Typing the project name lists its conversations, not every file it holds.
  assert.deepEqual(titles(rankPalette([conversation, file], 'nimbus', context)), [['Fix login']])
  // A context field alone never highlights anything in the row.
  const [hit] = rankPalette([conversation], 'nimbus', context)[0]!.hits
  assert.deepEqual([hit!.title, hit!.detail], [[], []])
  // With a word of its own matching, the project name narrows the file instead.
  assert.deepEqual(titles(rankPalette([conversation, file], 'nimbus index', context)), [['index.ts']])
})

test('a required field must match for the result to appear', () => {
  const setting = item('setting', 'Theme', null, {
    fields: [field('Theme', 'title', WEIGHT.title), field('Appearance', 'detail', WEIGHT.detail, { required: true })],
  })
  assert.equal(rankPalette([setting], 'theme', context).length, 0)
  assert.equal(rankPalette([setting], 'appearance theme', context).length, 1)
})

test('kind words list that kind', () => {
  const card = item('card', 'Broken build', 'p1', { fields: [field('Broken build', 'title', WEIGHT.title), kindField('ticket')] })
  assert.deepEqual(titles(rankPalette([card], 'ticket', context)), [['Broken build']])
})

test('the current project wins ties but not clearly better matches', () => {
  const equal = [item('conversation', 'Deploy', 'p1'), item('conversation', 'Deploy', 'p2')]
  const current = { ...context, currentProjectId: 'p2' }
  assert.deepEqual(rankPalette(equal, 'deploy', current).map((group) => group.key), ['p2', 'p1'])
  // Without a current project, sidebar order breaks the tie.
  assert.deepEqual(rankPalette(equal, 'deploy', context).map((group) => group.key), ['p1', 'p2'])
  const better = [item('conversation', 'Deploy', 'p1'), item('conversation', 'Docs: release plan for you', 'p2')]
  assert.equal(rankPalette(better, 'deploy', current)[0]!.key, 'p1')
})

test('a scope keeps its project, other projects by name, and commands', () => {
  const groups = rankPalette([
    item('conversation', 'Alpha notes', 'p1'),
    item('conversation', 'Alpha plan', 'p2'),
    item('project', 'Alpha', 'p2'),
    item('command', 'Alpha command', null),
    item('conversation', 'Alpha loose thread', null),
  ], 'alpha', context)
  const scoped = scopePalette(groups, 'p1')
  assert.equal(scoped.fallback, false)
  // The other project's conversation and the project-less thread are hidden but counted.
  assert.equal(scoped.elsewhere, 2)
  assert.deepEqual(scoped.groups.flatMap((group) => group.hits.map((hit) => hit.item.title)).sort(), ['Alpha', 'Alpha command', 'Alpha notes'])
})

test('a scope with nothing inside falls back to the unscoped results', () => {
  const groups = rankPalette([item('conversation', 'Beta', 'p2')], 'beta', context)
  assert.deepEqual(scopePalette(groups, 'p1'), { groups, elsewhere: 0, fallback: true })
})

test('a leading prefix restricts the kind and is not part of the query', () => {
  assert.deepEqual(parsePaletteQuery('  > theme '), { prefix: '>', text: 'theme' })
  assert.deepEqual(parsePaletteQuery('#12'), { prefix: '#', text: '12' })
  assert.deepEqual(parsePaletteQuery('src/app'), { prefix: null, text: 'src/app' })
  assert.deepEqual(parsePaletteQuery(''), { prefix: null, text: '' })
})

test('habit boosts grow with picks, halve every two weeks and stay below the project bonus', () => {
  const now = Date.UTC(2026, 10, 1)
  recordPaletteUse('a', now)
  const once = paletteUsageBoosts(now).get('a')!
  for (let index = 0; index < 1000; index += 1) recordPaletteUse('a', now)
  const often = paletteUsageBoosts(now).get('a')!
  assert.ok(often > once)
  // Habit settles near-ties; it must never outweigh the current-project bonus of 1.
  assert.ok(often <= 0.8)
  const later = paletteUsageBoosts(now + 14 * 24 * 60 * 60 * 1000).get('a')!
  assert.ok(Math.abs(later - often / 2) < 1e-9)
})

test('a damaged usage log costs only the habit ranking', () => {
  localStorage.setItem('sillage.palette.usage', '{not json')
  assert.equal(paletteUsageBoosts().size, 0)
  localStorage.setItem('sillage.palette.usage', JSON.stringify({ a: { count: 'x', at: 1 }, b: { count: 1, at: 1 } }))
  assert.deepEqual([...paletteUsageBoosts(1).keys()], ['b'])
})
