import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SlashCommandDto } from '@sillage/protocol'
import { matchAgents, matchCommands, matchSkills } from '../src/lib/composer-tokens'

const command = (name: string, aliases: string[] = [], description = `${name} command`): SlashCommandDto => ({
  name,
  aliases,
  description,
  argumentHint: '',
})

test('an alias finds its command once, under the typed name', () => {
  const commands = [command('usage', ['cost', 'stats']), command('compact')]
  assert.deepEqual(matchCommands(commands, 'co').map((entry) => entry.name), ['compact', 'cost'])
  // Both the canonical name and an alias match: the command is still listed once.
  assert.deepEqual(matchCommands([command('stats', ['status'])], 'stat').map((entry) => entry.name), ['stats'])
})

test('canonical names sort before aliases, then alphabetically, case-insensitively', () => {
  // `a-alias` sorts first alphabetically, yet a canonical name the user already knows comes first.
  const commands = [command('azure'), command('usage', ['a-alias']), command('Alpha')]
  assert.deepEqual(matchCommands(commands, 'a').map((entry) => entry.name), ['Alpha', 'azure', 'a-alias'])
  assert.deepEqual(matchCommands(commands, 'AL').map((entry) => entry.name), ['Alpha'])
})

test('summaries keep only the first description line and hints pass through', () => {
  const [entry] = matchCommands([{ ...command('review'), argumentHint: '<pr>', description: '  Review a PR  \nLong details' }], 'r')
  assert.deepEqual(entry, { name: 'review', hint: '<pr>', summary: 'Review a PR' })
})

test('skills match by prefix, alphabetically, without hints', () => {
  const skills = [
    { name: 'deploy-web', description: 'Ship the web\nmore' },
    { name: 'debug', description: 'Find bugs' },
    { name: 'release', description: 'Cut a release' },
  ]
  assert.deepEqual(matchSkills(skills, 'De'), [
    { name: 'debug', hint: '', summary: 'Find bugs' },
    { name: 'deploy-web', hint: '', summary: 'Ship the web' },
  ])
})

test('sub-agents: name prefix, first description line, never for a path', () => {
  const agents = [
    { name: 'general', description: 'General work' },
    { name: 'explore', description: 'Fast search\nUse it for broad sweeps.' },
  ]
  assert.deepEqual(matchAgents(agents, ''), [{ name: 'explore', description: 'Fast search' }, { name: 'general', description: 'General work' }])
  assert.deepEqual(matchAgents(agents, 'EX').map((agent) => agent.name), ['explore'])
  assert.deepEqual(matchAgents(agents, 'src/'), [])
})
