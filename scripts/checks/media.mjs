import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Sons, vidéos et modèles 3D dans l'éditeur, avec des fixtures fabriquées sur place :
 * un WAV d'une seconde, un cube OBJ avec son MTL, un STL ASCII et un GLB minimal.
 * Le navigateur lit le son via la route `file/raw`, ce qui vérifie le flux par
 * tranches ; le visualiseur compte les maillages, ce qui vérifie le chargement.
 */
export async function checkMedia({ page, context, base, project }) {
  const dir = join(project.workspacePath, 'media-check')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'tone.wav'), wav(1, 440))
  await writeFile(join(dir, 'cube.obj'), CUBE_OBJ)
  await writeFile(join(dir, 'cube.mtl'), CUBE_MTL)
  await writeFile(join(dir, 'tri.stl'), TRI_STL)
  await writeFile(join(dir, 'tri.glb'), glbTriangle())

  const raw = (path) => `${base}/api/projects/${project.id}/file/raw?path=${encodeURIComponent(path)}`
  const whole = await context.request.get(raw('media-check/tone.wav'))
  assert.equal(whole.status(), 200)
  assert.equal(whole.headers()['accept-ranges'], 'bytes')
  assert.equal(whole.headers()['content-type'], 'audio/wav')
  const part = await context.request.get(raw('media-check/tone.wav'), { headers: { range: 'bytes=0-3' } })
  assert.equal(part.status(), 206)
  assert.equal(part.headers()['content-range'], `bytes 0-3/${(await whole.body()).length}`)
  assert.equal((await part.body()).toString('latin1'), 'RIFF')
  const beyond = await context.request.get(raw('media-check/tone.wav'), { headers: { range: 'bytes=999999999-' } })
  assert.equal(beyond.status(), 416)
  assert.equal((await context.request.get(raw('media-check/tone.txt'))).status(), 415, 'Only listed extensions are served raw')

  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto(`${base}/p/${project.id}/board`)
  await page.getByRole('button', { name: 'Ouvrir le panneau', exact: true }).click()
  const panel = page.locator('[data-panel="workspace"]')
  const showTree = panel.getByRole('button', { name: "Afficher l'arborescence", exact: true })
  if (await showTree.count()) await showTree.click()
  // L'arborescence nomme ses entrées par leur nom court, suivi de la lettre d'état git
  // (`?` pour ces fixtures non suivies) ; le dossier se déplie une fois.
  const open = (name) => panel.getByRole('button', { name: new RegExp(`^${name.replace('.', '\\.')}\\b`) }).first().click()
  await open('media-check')

  await open('tone.wav')
  const audio = panel.locator('audio[title="media-check/tone.wav"]')
  await audio.waitFor()
  await page.waitForFunction((title) => {
    const node = document.querySelector(`audio[title="${title}"]`)
    return node && node.readyState >= 1 && node.duration > 0.9 && node.duration < 1.1
  }, 'media-check/tone.wav')

  const stats = panel.locator('text=/\\d+ maillages · \\d+ triangles/')
  await open('cube.obj')
  await panel.locator('canvas').waitFor()
  await stats.filter({ hasText: '1 maillages · 12 triangles' }).waitFor()
  await open('tri.stl')
  await stats.filter({ hasText: '1 maillages · 1 triangles' }).waitFor()
  await open('tri.glb')
  await stats.filter({ hasText: '1 maillages · 1 triangles' }).waitFor()
  assert.equal(await panel.locator('canvas').count(), 1, 'One WebGL context at a time: closed viewers must release theirs')
  await panel.getByRole('button', { name: 'Masquer la grille', exact: true }).click()
  await panel.getByRole('button', { name: 'Afficher la grille', exact: true }).waitFor()
  console.log('OK : lecture audio par tranches, cube OBJ avec matériaux, STL et GLB rendus.')
}

/** WAV PCM 16 bits mono, `seconds` secondes d'une sinusoïde à `frequency` Hz. */
function wav(seconds, frequency) {
  const rate = 8000
  const samples = rate * seconds
  const buffer = Buffer.alloc(44 + samples * 2)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + samples * 2, 4)
  buffer.write('WAVEfmt ', 8)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(rate, 24)
  buffer.writeUInt32LE(rate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 12000), 44 + i * 2)
  }
  return buffer
}

const CUBE_OBJ = `mtllib cube.mtl
o cube
v -1 -1 -1
v 1 -1 -1
v 1 1 -1
v -1 1 -1
v -1 -1 1
v 1 -1 1
v 1 1 1
v -1 1 1
usemtl red
f 1 2 3
f 1 3 4
f 5 8 7
f 5 7 6
f 1 5 6
f 1 6 2
f 2 6 7
f 2 7 3
f 3 7 8
f 3 8 4
f 5 1 4
f 5 4 8
`

const CUBE_MTL = `newmtl red
Kd 0.8 0.1 0.1
`

const TRI_STL = `solid tri
facet normal 0 0 1
outer loop
vertex 0 0 0
vertex 1 0 0
vertex 0 1 0
endloop
endfacet
endsolid tri
`

/** GLB d'un seul triangle : un tampon de trois positions, un maillage, une scène. */
function glbTriangle() {
  const positions = Buffer.from(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]).buffer)
  const json = JSON.stringify({
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] }],
    bufferViews: [{ buffer: 0, byteLength: positions.length }],
    buffers: [{ byteLength: positions.length }],
  })
  const pad = (buffer, fill) => Buffer.concat([buffer, Buffer.alloc((4 - (buffer.length % 4)) % 4, fill)])
  const jsonChunk = pad(Buffer.from(json), 0x20)
  const binChunk = pad(positions, 0)
  const header = Buffer.alloc(12)
  header.write('glTF', 0)
  header.writeUInt32LE(2, 4)
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8)
  const chunk = (type, body) => {
    const head = Buffer.alloc(8)
    head.writeUInt32LE(body.length, 0)
    head.writeUInt32LE(type, 4)
    return Buffer.concat([head, body])
  }
  return Buffer.concat([header, chunk(0x4e4f534a, jsonChunk), chunk(0x004e4942, binChunk)])
}
