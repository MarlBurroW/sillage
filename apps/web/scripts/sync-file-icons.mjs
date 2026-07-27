import { cp, mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Copie le jeu d'icônes de fichiers dans `public/`.
 *
 * Les 1250 SVG sont servis en statique plutôt qu'importés par le bundle : les inclure
 * ajouterait 240 Ko compressés au panneau pour des icônes dont on n'en affiche qu'une
 * poignée à la fois. Ici, chacune est demandée à l'usage et mise en cache par le
 * navigateur, et le paquet ne porte que la table de correspondance.
 *
 * Le précache du service worker ne les prend pas (`globPatterns` ne liste pas les
 * SVG) : les précacher ferait télécharger 1250 fichiers à chaque mise à jour.
 */

const require = createRequire(import.meta.url)
const web = join(dirname(fileURLToPath(import.meta.url)), '..')

const source = join(dirname(require.resolve('material-icon-theme/package.json')), 'icons')
const target = join(web, 'public/file-icons')

// Repartir d'un dossier propre : une icône retirée de la bibliothèque ne doit pas
// survivre indéfiniment dans `public/`.
await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
await cp(source, target, { recursive: true })
