import { Bot, Droplet, GitBranch, Globe, Lock, Search, Send, Sparkles, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { AppearanceControls } from '../components/AppearanceControls'
import { resolveToken, useAppearance } from '../lib/appearance'
import { useTranslate } from '../lib/i18n'
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
  const t = useTranslate()
  const [agent, setAgent] = useState('claude')
  const [text, setText] = useState('')
  // Remonté ici pour que la lecture des couleurs résolues se rafraîchisse au bougé
  // du curseur : c'est le rendu de cette page qui interroge les tokens.
  const appearance = useAppearance()

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-4 md:p-8">
      <header>
        <h1 className="text-lg font-semibold tracking-tight">{t('design.title')}</h1>
        <p className="mt-1 text-sm text-ink-faint">
          {t('design.intro.before')}{' '}
          <code className="font-mono text-ink-soft">--sg-hue</code>.
        </p>
      </header>

      <Card>
        <CardHeader
          title={t('design.surfaces.title')}
          description={t('design.surfaces.description')}
          icon={<Droplet size={16} />}
        />
        <CardBody>
          <AppearanceControls appearance={appearance} />
        </CardBody>
      </Card>

      <Section title={t('design.section.surfaces')}>
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

      <Section title={t('design.section.textAndStatus')}>
        <div className="flex flex-col gap-1">
          {INKS.map(([name, className]) => (
            <p key={name} className={`text-sm ${className}`}>
              <span className="font-mono text-xs">{name}</span> · {t('design.sample.sentence')}
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

      <Section title={t('design.section.buttons')}>
        <div className="flex flex-wrap items-center gap-2">
          <Button icon={<Send size={15} />}>{t('design.button.primary')}</Button>
          <Button variant="secondary">{t('design.button.secondary')}</Button>
          <Button variant="ghost">{t('design.button.ghost')}</Button>
          <Button variant="danger" icon={<Trash2 size={15} />}>
            {t('design.button.danger')}
          </Button>
          <Button disabled>{t('design.button.disabled')}</Button>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button size="sm">{t('design.button.small')}</Button>
          <Button size="sm" variant="secondary">
            {t('design.button.smallSecondary')}
          </Button>
          <IconButton label={t('design.button.search')}>
            <Search size={18} />
          </IconButton>
        </div>
      </Section>

      <Section title={t('design.section.fields')}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label={t('design.field.withIcon')}
            icon={<Search size={16} />}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('design.field.searchPlaceholder')}
          />
          <Field
            label={t('design.field.withHint')}
            hint={t('design.field.hostPathHint')}
            defaultValue="/home"
          />
          <Field
            label={t('design.field.withError')}
            error={t('design.field.folderMissing')}
            defaultValue="/nope"
          />
          <Select label="CLI" value={agent} onChange={setAgent} options={AGENTS} />
        </div>
      </Section>

      <Section title={t('design.section.messages')}>
        <div className="flex flex-col gap-2">
          <Banner tone="critical">{t('design.message.invalidCredentials')}</Banner>
          <Banner tone="caution">{t('design.message.uncommittedWorktree')}</Banner>
          <Banner tone="info">{t('design.message.runnerResumed')}</Banner>
        </div>
      </Section>

      <Section title={t('design.section.cards')}>
        <Card>
          <CardHeader
            title={t('design.card.title')}
            description={t('design.card.description')}
            icon={<Lock size={16} />}
            actions={
              <Badge tone="accent" icon={<Globe size={11} />}>
                {t('design.card.shared')}
              </Badge>
            }
          />
          <CardBody>
            <p className="text-sm text-ink-soft">{t('design.card.body')}</p>
          </CardBody>
        </Card>
      </Section>

      <Section title={t('design.section.emptyState')}>
        <Card>
          <EmptyState
            icon={<Search size={22} />}
            title={t('design.empty.title')}
            description={t('design.empty.description')}
            action={<Button variant="secondary">{t('design.empty.reset')}</Button>}
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
