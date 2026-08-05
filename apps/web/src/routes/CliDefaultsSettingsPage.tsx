import { ShieldAlert, SlidersHorizontal } from 'lucide-react'
import { useState } from 'react'
import { agentKindSchema, defaultConfigFor, type AgentConfig, type AgentKind } from '@sillage/protocol'
import { AGENT_LABELS, AGENT_META, AgentIcon } from '../components/AgentIcon'
import { useAgentSettings } from '../components/chat/agent-settings'
import type { SettingGroup } from '../components/chat/ComposerSettings'
import { Banner, Card, CardBody, CardHeader, ChoiceList, Select } from '../components/ui'
import { useTranslate } from '../lib/i18n'
import { useUpdateAgentDefault, useUserSettings } from '../lib/user-settings'
import { SectionHeader } from './SettingsPage'

/**
 * Avec quoi les prochaines conversations s'ouvrent.
 *
 * Réglage de compte et non d'instance : le mode de permission engage celui qui lit les
 * réponses, et deux personnes du même projet n'ont pas à travailler avec les mêmes
 * garde-fous. Rien n'est appliqué aux conversations existantes, qui portent chacune sa
 * configuration : changer un défaut ne doit pas modifier sous les doigts un fil déjà
 * ouvert.
 *
 * Les mêmes catégories que le panneau du composeur, à la même source : ce qu'on règle
 * ici est exactement ce qu'on y retrouvera, déplié plutôt que rangé derrière un
 * déclencheur qui doit tenir sur une ligne.
 */
export function CliDefaultsSettingsPage() {
  const t = useTranslate()
  const { data: settings } = useUserSettings()
  const update = useUpdateAgentDefault()

  const [agent, setAgent] = useState<AgentKind>('claude')
  /**
   * Le choix en cours, tant que la route n'a pas confirmé. Sans lui, chaque option
   * choisie reviendrait à sa valeur d'avant le temps de l'aller-retour. Abandonné dès
   * que le CLI change : une configuration Claude n'a aucun sens pour Codex.
   */
  const [edited, setEdited] = useState<AgentConfig | null>(null)
  const stored = settings?.agentDefaults[agent]
  const config = edited?.agent === agent ? edited : (stored ?? defaultConfigFor(agent))

  const save = (next: AgentConfig) => {
    setEdited(next)
    update.mutate(next)
  }

  const { groups, mcp, catalogError } = useAgentSettings({ config, onConfigChange: save })

  const agents = agentKindSchema.options.map((value) => ({
    value,
    label: AGENT_LABELS[value],
    hint: AGENT_META[value].vendor,
    icon: <AgentIcon agent={value} size={16} />,
  }))

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader
        title={t('cliDefaults.section.title')}
        description={t('cliDefaults.section.description')}
      />

      <Card>
        <CardHeader
          title={t('cliDefaults.agent.title')}
          description={t('cliDefaults.agent.description')}
          icon={<SlidersHorizontal size={16} />}
        />
        <CardBody>
          <ChoiceList
            label={t('draft.cli.legend')}
            value={agent}
            options={agents}
            onChange={setAgent}
          />
        </CardBody>
      </Card>

      <Card>
        <CardHeader title={AGENT_LABELS[agent]} icon={<AgentIcon agent={agent} size={16} />} />
        <CardBody className="flex flex-col gap-4">
          {catalogError ? <Banner tone="caution">{t('composer.catalog.unavailable')}</Banner> : null}
          {update.isError ? <Banner>{t('cliDefaults.save.error')}</Banner> : null}

          {/* Rien tant que les défauts du compte ne sont pas connus : les afficher
              avant reviendrait à proposer de cliquer sur des valeurs qui ne sont pas
              les siennes, et un clic les enregistrerait pour de bon. */}
          {settings ? (
            <>
              {groups.map((group) => (
                <GroupField key={group.key} group={group} />
              ))}

              <div className="flex flex-col gap-1.5">
                <span className="text-sm font-medium text-ink-soft">
                  {t('cliDefaults.mcp.label')}
                </span>
                {/* Le contrôle porte déjà son icône et son décompte : l'encadrer d'un
                    second repère ferait deux prises pour un seul réglage. */}
                <div className="flex">{mcp}</div>
                <p className="text-xs text-ink-faint">{t('cliDefaults.mcp.hint')}</p>
              </div>
            </>
          ) : null}
        </CardBody>
      </Card>
    </div>
  )
}

/**
 * Une catégorie, en liste déroulante : celle des modèles est trop longue pour être
 * dépliée, et aligner les autres dessus vaut mieux qu'un écran où chaque réglage a sa
 * forme propre. Le ton d'alerte, que le déclencheur ne peut pas porter, est rappelé
 * sous le champ : c'est le seul endroit où l'on choisit un garde-fou sans voir le
 * travail qu'il encadre.
 */
function GroupField({ group }: { group: SettingGroup }) {
  const selected = group.options.find((option) => option.value === group.value)

  return (
    <div className="flex flex-col gap-1.5">
      <Select
        label={group.label}
        value={group.value}
        options={group.options}
        onChange={group.onChange}
      />
      {selected?.tone === 'caution' ? (
        <p className="flex items-start gap-1.5 text-xs text-caution">
          <ShieldAlert size={13} className="mt-0.5 shrink-0" />
          <span>{selected.hint}</span>
        </p>
      ) : null}
    </div>
  )
}
