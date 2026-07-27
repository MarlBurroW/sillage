import { Bot, Droplet, GitBranch, Globe, Lock, Search, Send, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AppearanceControls } from '../components/AppearanceControls'
import { resolveToken, useAppearance } from '../lib/appearance'
import {
  Badge,
  Banner,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Field,
  IconButton,
  Select,
  type SelectOption,
} from '../components/ui'

/**
 * Catalogue du design system. Sert de terrain d'itération : tous les composants sur
 * un écran, dans les trois thèmes, pour juger la cohérence sans avoir à naviguer.
 */

// Classes écrites en toutes lettres : Tailwind scanne les fichiers source et ne
// génère rien pour une classe construite dynamiquement.
const SURFACES = [
  ['canvas', 'bg-canvas', '--sg-canvas'],
  ['surface', 'bg-surface', '--sg-surface'],
  ['surface-high', 'bg-surface-high', '--sg-surface-high'],
  ['sunken', 'bg-sunken', '--sg-sunken'],
] as const

const INKS = [
  ['ink', 'text-ink'],
  ['ink-soft', 'text-ink-soft'],
  ['ink-faint', 'text-ink-faint'],
] as const

const STATUS = ['accent', 'positive', 'caution', 'critical'] as const

const AGENTS: SelectOption<string>[] = [
  { value: 'claude', label: 'Claude Code', icon: <Sparkles size={15} />, hint: 'Agent SDK' },
  { value: 'codex', label: 'Codex', icon: <Bot size={15} />, hint: 'app-server' },
  { value: 'gemini', label: 'Gemini CLI', icon: <Bot size={15} />, disabled: true },
]

export function DesignPage() {
  const [agent, setAgent] = useState('claude')
  const [text, setText] = useState('')
  // Remonté ici pour que la lecture des couleurs résolues se rafraîchisse au bougé
  // du curseur : c'est le rendu de cette page qui interroge les tokens.
  const appearance = useAppearance()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-4 md:p-8">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">Design system</h1>
        <p className="mt-1 text-sm text-ink-faint">
          Toutes les surfaces dérivent de la teinte d'accent, réglée par le token{' '}
          <code className="font-mono text-ink-soft">--sg-hue</code>.
        </p>
      </header>

      <Card>
        <CardHeader
          title="Teinte des surfaces"
          description="hue est partagée avec l'accent, tint multiplie la chroma des surfaces seules."
          icon={<Droplet size={16} />}
        />
        <CardBody>
          <AppearanceControls appearance={appearance} />
        </CardBody>
      </Card>

      <Section title="Surfaces">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {SURFACES.map(([name, className, token]) => (
            <div key={name} className="flex flex-col gap-1.5">
              <div className={`h-14 rounded-md border border-line ${className}`} />
              <span className="font-mono text-xs text-ink-faint">{name}</span>
              <span className="font-mono text-[0.6875rem] text-ink-faint">
                {resolveToken(token)}
              </span>
            </div>
          ))}
        </div>
      </Section>

      <Section title="Texte et statuts">
        <div className="flex flex-col gap-1">
          {INKS.map(([name, className]) => (
            <p key={name} className={`text-sm ${className}`}>
              <span className="font-mono text-xs">{name}</span> · Le vif zéphyr jubile sur les
              quais.
            </p>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          {STATUS.map((tone) => (
            <Badge key={tone} tone={tone}>
              {tone}
            </Badge>
          ))}
          <Badge icon={<GitBranch size={11} />}>main</Badge>
        </div>
      </Section>

      <Section title="Boutons">
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Send size={15} />}>Primaire</Button>
          <Button variant="secondary">Secondaire</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger" icon={<Trash2 size={15} />}>
            Danger
          </Button>
          <Button disabled>Désactivé</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm">Petit</Button>
          <Button size="sm" variant="secondary">
            Petit secondaire
          </Button>
          <IconButton label="Rechercher">
            <Search size={18} />
          </IconButton>
        </div>
      </Section>

      <Section title="Champs">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Avec icône"
            icon={<Search size={16} />}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Rechercher..."
          />
          <Field label="Avec aide" hint="Chemin absolu sur la machine hôte." defaultValue="/home" />
          <Field label="En erreur" error="Le dossier n'existe pas." defaultValue="/nope" />
          <Select label="CLI" value={agent} onChange={setAgent} options={AGENTS} />
        </div>
      </Section>

      <Section title="Messages">
        <div className="flex flex-col gap-2">
          <Banner tone="critical">Identifiants incorrects.</Banner>
          <Banner tone="caution">Modifications non commitées dans ce worktree.</Banner>
          <Banner tone="info">Le runner a été relancé en reprise de session.</Banner>
        </div>
      </Section>

      <Section title="Cartes">
        <Card>
          <CardHeader
            title="Titre de carte"
            description="Une ligne de description sous le titre."
            icon={<Lock size={16} />}
            actions={
              <Badge tone="accent" icon={<Globe size={11} />}>
                Partagé
              </Badge>
            }
          />
          <CardBody>
            <p className="text-sm text-ink-soft">
              Le corps de la carte. Le dégradé de surface est visible sur les grandes hauteurs.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section title="État vide">
        <Card>
          <EmptyState
            icon={<Search size={22} />}
            title="Aucun résultat"
            description="Essaie un autre terme de recherche."
            action={<Button variant="secondary">Réinitialiser</Button>}
          />
        </Card>
      </Section>
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-3 text-sm font-semibold text-ink-soft">{title}</h2>
      {children}
    </section>
  )
}
