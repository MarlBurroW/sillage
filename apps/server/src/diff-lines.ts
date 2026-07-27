/**
 * Diff unifié entre deux textes, ligne à ligne.
 *
 * Écrit ici plutôt qu'ajouté en dépendance : c'est le seul endroit où Sillage doit
 * *calculer* un diff, git le fournissant partout ailleurs. Le format produit est
 * exactement celui que git émet, donc le même analyseur le rend côté client.
 */

/**
 * Au-delà, la table de la plus longue sous-séquence commune coûte des dizaines de
 * millions de cellules pour un résultat que personne ne lira ligne à ligne : le
 * fichier est alors présenté comme entièrement remplacé, ce qui est vrai.
 */
const MAX_LINES = 2000

interface Op {
  kind: ' ' | '-' | '+'
  text: string
}

/**
 * Plus longue sous-séquence commune, en table de programmation dynamique.
 *
 * Table plate plutôt qu'un tableau de tableaux : c'est le même calcul, sans allouer
 * une ligne par ligne de fichier.
 */
function align(before: string[], after: string[]): Op[] {
  const rows = before.length
  const cols = after.length
  const width = cols + 1
  const lengths = new Int32Array((rows + 1) * width)
  const at = (i: number, j: number) => lengths[i * width + j] ?? 0

  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        before[i] === after[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1))
    }
  }

  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < rows && j < cols) {
    if (before[i] === after[j]) {
      ops.push({ kind: ' ', text: before[i] ?? '' })
      i += 1
      j += 1
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      ops.push({ kind: '-', text: before[i] ?? '' })
      i += 1
    } else {
      ops.push({ kind: '+', text: after[j] ?? '' })
      j += 1
    }
  }
  for (; i < rows; i += 1) ops.push({ kind: '-', text: before[i] ?? '' })
  for (; j < cols; j += 1) ops.push({ kind: '+', text: after[j] ?? '' })

  return ops
}

function replaceAll(before: string[], after: string[]): Op[] {
  return [
    ...before.map((text): Op => ({ kind: '-', text })),
    ...after.map((text): Op => ({ kind: '+', text })),
  ]
}

/**
 * Un unique bloc couvrant tout le texte comparé : les deux fragments sont courts et
 * les découper en sections masquerait ce qui les entoure.
 */
export function unifiedDiff(path: string, before: string, after: string): string {
  const left = before.split('\n')
  const right = after.split('\n')

  const ops =
    left.length > MAX_LINES || right.length > MAX_LINES ? replaceAll(left, right) : align(left, right)

  const body = ops.map((op) => `${op.kind}${op.text}`).join('\n')
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${left.length} +1,${right.length} @@`,
    body,
  ].join('\n')
}

/**
 * Fichier créé ou supprimé en entier : il n'y a rien à comparer, seulement un côté.
 *
 * Les deux CLI donnent ce contenu brut plutôt qu'un diff dans ce cas, et un contenu
 * brut ne se rend pas comme un diff : il est enveloppé ici dans la forme que git
 * produirait, pour que l'affichage n'ait qu'un seul format à connaître.
 */
function wholeFileDiff(path: string, content: string, side: 'added' | 'removed'): string {
  const lines = content.split('\n')
  const added = side === 'added'
  return [
    `diff --git a/${path} b/${path}`,
    added ? 'new file mode 100644' : 'deleted file mode 100644',
    added ? '--- /dev/null' : `--- a/${path}`,
    added ? `+++ b/${path}` : '+++ /dev/null',
    added ? `@@ -0,0 +1,${lines.length} @@` : `@@ -1,${lines.length} +0,0 @@`,
    lines.map((line) => `${added ? '+' : '-'}${line}`).join('\n'),
  ].join('\n')
}

export function additionDiff(path: string, content: string): string {
  return wholeFileDiff(path, content, 'added')
}

export function deletionDiff(path: string, content: string): string {
  return wholeFileDiff(path, content, 'removed')
}
