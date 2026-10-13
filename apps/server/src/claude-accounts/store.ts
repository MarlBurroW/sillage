import { randomUUID } from 'node:crypto'
import { and, asc, eq } from 'drizzle-orm'
import { claudeAccounts, type Db } from '@sillage/db'
import { claudeSecretKind, type ClaudeAccount, type ClaudeAccountKind } from '@sillage/protocol'
import { decryptValue, encryptValue } from '../secrets/cipher.js'
import type { ClaudeAccountGauges } from './gauges.js'

/**
 * Secrets des comptes Claude supplémentaires, un par compte et par utilisateur.
 *
 * Le gestionnaire de sessions en lit un au lancement d'une conversation qui le
 * désigne, pour le poser dans l'environnement du CLI ; les routes ne rendent que le
 * libellé et la nature du secret, comme pour les credentials git.
 */
export class ClaudeAccountStore {
  constructor(
    private readonly db: Db,
    private readonly key: Buffer,
    /** Absentes, aucun compte n'a de jauge : c'est le cas des tests qui ne la regardent pas. */
    readonly gauges: ClaudeAccountGauges | null = null,
  ) {}

  list(ownerId: string): ClaudeAccount[] {
    return this.db
      .select({
        id: claudeAccounts.id,
        label: claudeAccounts.label,
        kind: claudeAccounts.kind,
        createdAt: claudeAccounts.createdAt,
        updatedAt: claudeAccounts.updatedAt,
      })
      .from(claudeAccounts)
      .where(eq(claudeAccounts.ownerId, ownerId))
      .orderBy(asc(claudeAccounts.label))
      .all()
      .map((row) => ({ ...row, gauge: this.gaugeOf(row.id, row.kind) }))
  }

  /** Le compte, s'il appartient bien à cet utilisateur, sans son secret. */
  find(ownerId: string, id: string): ClaudeAccount | undefined {
    return this.list(ownerId).find((account) => account.id === id)
  }

  /** Une clé API n'a pas de forfait : sa jauge n'a pas de sens, même un dossier oublié. */
  private gaugeOf(id: string, kind: ClaudeAccountKind): ClaudeAccount['gauge'] {
    return kind === 'oauth' ? (this.gauges?.describe(id) ?? null) : null
  }

  /** Faux quand le libellé est déjà pris par un autre compte du même utilisateur. */
  labelFree(ownerId: string, label: string, exceptId?: string): boolean {
    const existing = this.db
      .select({ id: claudeAccounts.id })
      .from(claudeAccounts)
      .where(and(eq(claudeAccounts.ownerId, ownerId), eq(claudeAccounts.label, label)))
      .get()
    return !existing || existing.id === exceptId
  }

  create(ownerId: string, label: string, secret: string): ClaudeAccount {
    const now = Date.now()
    const id = randomUUID()
    const kind = claudeSecretKind(secret)
    this.db
      .insert(claudeAccounts)
      .values({ id, ownerId, label, kind, ...encryptValue(this.key, secret), createdAt: now, updatedAt: now })
      .run()
    return { id, label, kind, gauge: null, createdAt: now, updatedAt: now }
  }

  /** Renomme, ou remplace le secret : un jeton expiré se réécrit, il ne se corrige pas. */
  update(ownerId: string, id: string, patch: { label?: string; token?: string }): boolean {
    if (!this.row(ownerId, id)) return false
    this.db
      .update(claudeAccounts)
      .set({
        ...(patch.label === undefined ? {} : { label: patch.label }),
        ...(patch.token === undefined
          ? {}
          : { kind: claudeSecretKind(patch.token), ...encryptValue(this.key, patch.token) }),
        updatedAt: Date.now(),
      })
      .where(eq(claudeAccounts.id, id))
      .run()
    return true
  }

  delete(ownerId: string, id: string): boolean {
    if (!this.row(ownerId, id)) return false
    this.db.delete(claudeAccounts).where(eq(claudeAccounts.id, id)).run()
    // Sa connexion de jauge part avec lui : un abonnement qu'on retire ne se lit plus.
    this.gauges?.forget(id)
    return true
  }

  /**
   * Le secret en clair et sa nature, pour l'environnement d'une session. Le
   * propriétaire est exigé avec l'identifiant : une configuration de projet partagée
   * peut désigner le compte d'un autre, qui ne doit pas se retrouver dans ses sessions.
   */
  resolveToken(ownerId: string, id: string): { label: string; kind: ClaudeAccountKind; token: string } | undefined {
    const row = this.row(ownerId, id)
    if (!row) return undefined
    try {
      return { label: row.label, kind: row.kind, token: decryptValue(this.key, row) }
    } catch (err) {
      throw new Error(
        `Le secret du compte Claude « ${row.label} » n'a pas pu être déchiffré : ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          'La clé de chiffrement ne correspond pas à la base, ou la ligne a été modifiée.',
      )
    }
  }

  private row(ownerId: string, id: string) {
    return this.db
      .select()
      .from(claudeAccounts)
      .where(and(eq(claudeAccounts.ownerId, ownerId), eq(claudeAccounts.id, id)))
      .get()
  }
}
