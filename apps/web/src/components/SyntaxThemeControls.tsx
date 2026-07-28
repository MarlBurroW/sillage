import { Check } from 'lucide-react'
import { HighlightedCode } from './chat/HighlightedCode'
import { useTranslate } from '../lib/i18n'
import { SYNTAX_THEMES, SYNTAX_THEME_LABELS, useSyntaxTheme } from '../lib/syntax-theme'
import { useTheme } from '../lib/theme'
import { cx } from './ui'

/**
 * Extrait d'aperçu.
 *
 * Choisi pour porter les sept rôles à la fois : commentaire, mot-clé, chaîne, nombre,
 * fonction, type et propriété. Un extrait qui n'en montrerait que trois ferait choisir
 * une palette sur une impression partielle.
 */
const SAMPLE = `// Occupation de la fenêtre de contexte, telle que le CLI la rapporte.
import { readFile } from 'node:fs/promises'

const SEUIL = 0.85
type Niveau = 'calme' | 'tendu'

export async function decrire(state: ContextState): Promise<string> {
  const ratio = state.usedTokens / state.maxTokens
  const niveau: Niveau = ratio > SEUIL ? 'tendu' : 'calme'
  const modele = await readFile('./modele.txt', 'utf8')

  return \`\${modele} : \${Math.round(ratio * 100)} % (\${niveau})\`
}`

/** Rôles montrés en pastilles, dans l'ordre où ils sautent aux yeux dans du code. */
const SWATCHES = ['keyword', 'string', 'function', 'number', 'comment'] as const

export function SyntaxThemeControls() {
  const [theme] = useTheme()
  const [syntax, setSyntax] = useSyntaxTheme()
  const t = useTranslate()

  // Le thème contrasté impose sa propre palette : l'aperçu doit montrer ce qui
  // s'affichera réellement, pas la palette choisie mais inappliquée.
  const applies = theme !== 'dark-contrast'

  return (
    <div className="flex flex-col gap-3">
      {/* Grille plutôt qu'un enroulement : les cases gardent la même largeur quelle
          que soit la sélection, donc choisir une palette ne redistribue pas les
          autres sous les yeux. */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {SYNTAX_THEMES.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setSyntax(option)}
            aria-pressed={syntax === option}
            // Les deux attributs portent la palette localement : les pastilles
            // montrent ses vraies couleurs sans que l'application en change.
            data-theme={theme === 'dark-contrast' ? 'dark' : theme}
            data-syntax={option}
            className={cx(
              'flex items-center gap-2 rounded-md border px-2.5 py-2 transition-colors',
              syntax === option
                ? 'border-accent bg-accent-wash text-ink'
                : 'border-line text-ink-soft hover:border-line-strong hover:text-ink',
            )}
          >
            <span className="flex shrink-0 gap-1">
              {SWATCHES.map((role) => (
                <span
                  key={role}
                  aria-hidden
                  className="size-2.5 rounded-full"
                  style={{ background: `var(--sg-syn-${role})` }}
                />
              ))}
            </span>
            <span className="min-w-0 flex-1 truncate text-left text-xs font-medium">
              {t(SYNTAX_THEME_LABELS[option])}
            </span>
            {/* La coche occupe sa place même absente : la faire apparaître décalait
                tout le reste de la case au moment du clic. */}
            <Check
              size={13}
              className={cx('shrink-0 text-accent', syntax === option ? '' : 'invisible')}
            />
          </button>
        ))}
      </div>

      {applies ? null : (
        <p className="text-xs text-caution">{t('theme.syntax.contrastNotice')}</p>
      )}

      <HighlightedCode
        code={SAMPLE}
        language="ts"
        className="rounded-md border border-line bg-sunken p-3 font-mono text-xs"
      />
    </div>
  )
}
