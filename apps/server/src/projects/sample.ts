import { execFile } from 'node:child_process'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import type { AppContext } from '../http/context.js'
import { badRequest } from '../http/errors.js'
import { insertProject } from './create.js'

const run = promisify(execFile)

/**
 * Le projet d'essai de la visite.
 *
 * Un dépôt de quelques fichiers, avec des tests qui échouent exprès : de quoi voir un
 * agent lire, corriger et proposer un commit sans toucher à un vrai dépôt. Node suffit à
 * lancer les tests, puisque Sillage tourne dessus. Le dossier porte un nom reconnaissable,
 * pour qu'on sache ce que c'est et qu'on le retire sans hésiter.
 */
const SAMPLE_DIRECTORY = 'sillage-sample'
const SAMPLE_NAME = 'Sillage sample'

const FILES: Record<string, string> = {
  'package.json': `${JSON.stringify(
    {
      name: 'sillage-sample',
      private: true,
      type: 'module',
      scripts: { test: 'node --test' },
    },
    null,
    2,
  )}\n`,
  '.gitignore': 'node_modules/\n',
  'README.md': `# Sillage sample

A tiny shopping-cart module, written for a first conversation with an agent.

Two of its tests fail on purpose. Try asking the agent:

- "Run the tests and fix what breaks."
- "Explain how this project is organised."
- "Add a function that removes an item from the cart, with a test."

Run the tests yourself with \`npm test\` (Node 20 or later, no dependencies).

Created by Sillage; delete this folder whenever you like.
`,
  'src/cart.js': `/**
 * A shopping cart: a list of items, each with a name, a unit price and a quantity.
 */

export function createCart() {
  return { items: [] }
}

export function addItem(cart, name, price, quantity = 1) {
  if (price < 0) throw new RangeError('price must be positive')
  if (!Number.isInteger(quantity) || quantity < 1) throw new RangeError('quantity must be a positive integer')
  const existing = cart.items.find((item) => item.name === name)
  if (existing) {
    existing.quantity += quantity
  } else {
    cart.items.push({ name, price, quantity })
  }
  return cart
}

/** Sum of every line: unit price times quantity. */
export function total(cart) {
  return cart.items.reduce((sum, item) => sum + item.price, 0)
}

/** The total after a percentage discount, never below zero. */
export function applyDiscount(amount, percent) {
  if (percent < 0 || percent > 100) throw new RangeError('percent must be between 0 and 100')
  return Math.max(0, amount - percent)
}
`,
  'test/cart.test.js': `import assert from 'node:assert/strict'
import { test } from 'node:test'
import { addItem, applyDiscount, createCart, total } from '../src/cart.js'

test('an empty cart totals zero', () => {
  assert.equal(total(createCart()), 0)
})

test('adding the same item twice merges the quantities', () => {
  const cart = addItem(addItem(createCart(), 'pen', 2), 'pen', 2, 3)
  assert.equal(cart.items.length, 1)
  assert.equal(cart.items[0].quantity, 4)
})

test('the total multiplies the unit price by the quantity', () => {
  const cart = addItem(addItem(createCart(), 'pen', 2, 3), 'notebook', 5)
  assert.equal(total(cart), 11)
})

test('a discount is a percentage of the amount', () => {
  assert.equal(applyDiscount(80, 25), 60)
  assert.equal(applyDiscount(10, 100), 0)
})

test('a negative price is refused', () => {
  assert.throws(() => addItem(createCart(), 'pen', -1), RangeError)
})
`,
}

/**
 * Le premier dossier libre : `sillage-sample`, puis `sillage-sample-2`, et ainsi de suite.
 * Un projet d'essai déjà créé puis retiré de Sillage laisse son dossier sur le disque.
 */
async function freeDirectory(parent: string): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt++) {
    const name = attempt === 1 ? SAMPLE_DIRECTORY : `${SAMPLE_DIRECTORY}-${attempt}`
    const path = join(parent, name)
    const entries = await readdir(path).catch(() => null)
    if (entries === null || entries.length === 0) return path
  }
  throw badRequest('sample_directory_taken', 'Too many sample projects already exist in {path}.', { path: parent })
}

/**
 * Un dépôt git dès le départ : sans lui, ni les points de reprise ni le panneau git
 * n'auraient rien à montrer, et c'est ce que la visite cherche à faire voir. Un git
 * absent n'empêche pas le projet d'exister : les tests se lancent quand même.
 */
async function initRepository(path: string): Promise<void> {
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.name=Sillage', '-c', 'user.email=sillage@localhost', ...args], { cwd: path })
  try {
    await git('init', '-q', '-b', 'main')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'Add the Sillage sample project')
  } catch {
    // Sans git sur la machine, le dossier reste un simple projet.
  }
}

export async function createSampleProject(
  ctx: AppContext,
  ownerId: string,
  input: { parentDir: string; visibility: 'private' | 'shared' },
) {
  if (!isAbsolute(input.parentDir)) {
    throw badRequest('workspace_not_absolute', 'The workspace path must be absolute.')
  }
  const parent = resolve(input.parentDir)
  await mkdir(parent, { recursive: true })
  const info = await stat(parent).catch(() => null)
  if (!info?.isDirectory()) {
    throw badRequest('workspace_not_a_directory', '{path} is not a directory.', { path: parent })
  }

  const workspacePath = await freeDirectory(parent)
  for (const [name, content] of Object.entries(FILES)) {
    const target = join(workspacePath, name)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, content, 'utf8')
  }
  await initRepository(workspacePath)

  return insertProject(ctx, ownerId, {
    name: SAMPLE_NAME,
    workspacePath,
    visibility: input.visibility,
    color: null,
    // Le dépôt n'a pas de consignes : celles de Sillage, qui s'écrivent depuis la page.
    instructionsMode: 'sillage',
  })
}
