import assert from 'node:assert/strict'
import { test } from 'node:test'
import { en, type MessageKey } from '../src/lib/i18n/catalog-en'
import { fr } from '../src/lib/i18n/catalog-fr'
import { translate, translateError } from '../src/lib/i18n'

/** `{name}` markers of a template, sorted: a translation may move them but not rename or drop them. */
function placeholders(template: string): string[] {
  return [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1]!).sort()
}

// The `Catalog` type catches missing French keys, but not extra ones: `...exportFr` is spread, so
// excess-property checks never see its keys, and a stale key would ship dead text.
test('the French catalog has exactly the English keys', () => {
  const english = new Set(Object.keys(en))
  const french = new Set(Object.keys(fr))
  assert.deepEqual([...french].filter((key) => !english.has(key)), [], 'keys only in French')
  assert.deepEqual([...english].filter((key) => !french.has(key)), [], 'keys only in English')
})

// An empty string is a valid `string` for the compiler but renders as a blank button or label.
test('no catalog entry is empty', () => {
  for (const [name, catalog] of Object.entries({ en, fr })) {
    const empty = Object.entries(catalog).filter(([, text]) => text.trim() === '').map(([key]) => key)
    assert.deepEqual(empty, [], `empty ${name} entries`)
  }
})

// `interpolate` leaves unknown markers visible, so a renamed `{count}` in French would show raw
// braces to French readers only, where English review never sees it.
test('French entries use the same placeholders as English', () => {
  const mismatched = (Object.keys(en) as MessageKey[]).filter(
    (key) => fr[key] !== undefined && placeholders(fr[key]).join() !== placeholders(en[key]).join(),
  )
  assert.deepEqual(mismatched, [])
})

test('translate substitutes markers and keeps unknown ones visible', () => {
  // Under Node no document exists, so the module stays on its English fallback.
  assert.equal(translate('projectSelector.count', { count: 3 }), '3 projects selected')
  assert.equal(translate('projectSelector.count'), '{count} projects selected')
  assert.equal(translate('projectSelector.count', { other: 1 }), '{count} projects selected')
  assert.equal(translate('projectSelector.count', { count: 0 }), '0 projects selected')
})

test('translateError prefers the catalog and falls back on the server message', () => {
  const known = (Object.keys(en) as string[]).find((key) => key.startsWith('error.') && placeholders(en[key as MessageKey]).length === 0)
  assert.ok(known, 'the catalog translates at least one server error code')
  assert.equal(translateError(known.slice('error.'.length), 'ignored', {}), en[known as MessageKey])
  // An unknown code must not surface as a raw identifier: the English sentence is still accurate.
  assert.equal(translateError('no_such_code', 'Project {name} is gone', { name: 'nimbus' }), 'Project nimbus is gone')
})
