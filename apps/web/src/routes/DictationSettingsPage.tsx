import { useMutation } from '@tanstack/react-query'
import { KeyRound, Mic, RadioTower, ShieldCheck, Sparkles } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { Banner, Button, Card, CardBody, CardHeader, EmptyState, Field, Select, cx } from '../components/ui'
import { SectionHeader } from './SettingsPage'
import { ApiRequestError } from '../lib/api'
import { useAppSettings, useUpdateAppSettings } from '../lib/app-settings'
import { useTranslate } from '../lib/i18n'
import { useSecrets } from '../lib/secrets'
import { useCurrentUser } from '../lib/session'
import { testDictation } from '../lib/stt'

/**
 * Dictée vocale, branchée sur n'importe quelle API au format OpenAI.
 *
 * Les presets ne sont que du confort de saisie : sous le capot il n'existe qu'un seul
 * client, et un fournisseur absent de la liste se configure par son URL. La clé d'API
 * vit dans le dépôt de secrets, cette page n'en manipule que le nom.
 */

interface Preset {
  name: string
  baseUrl: string
  model: string
  cleanupModel: string
}

const PRESETS: Preset[] = [
  {
    name: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'voxtral-mini-latest',
    cleanupModel: 'mistral-small-latest',
  },
  {
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'whisper-large-v3-turbo',
    cleanupModel: 'llama-3.3-70b-versatile',
  },
  {
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini-transcribe',
    cleanupModel: 'gpt-4o-mini',
  },
]

export function DictationSettingsPage() {
  const t = useTranslate()
  const { data: me } = useCurrentUser()
  const isAdmin = me?.isAdmin === true
  const { data: settings } = useAppSettings()
  const { data: secretList } = useSecrets(isAdmin)
  const update = useUpdateAppSettings()
  const test = useMutation({ mutationFn: testDictation })

  const [baseUrl, setBaseUrl] = useState('')
  const [model, setModel] = useState('')
  const [secret, setSecret] = useState('')
  const [cleanupModel, setCleanupModel] = useState('')
  // Les champs suivent la valeur du serveur tant qu'on n'y a pas touché : sans ça ils
  // restent vides au premier rendu, la requête n'ayant pas encore répondu.
  useEffect(() => {
    if (!settings) return
    setBaseUrl(settings.sttBaseUrl)
    setModel(settings.sttModel)
    setSecret(settings.sttSecret)
    setCleanupModel(settings.sttCleanupModel)
  }, [settings])

  if (!isAdmin) {
    return (
      <EmptyState
        icon={<ShieldCheck size={22} />}
        title={t('stt.adminOnly.title')}
        description={t('stt.adminOnly.description')}
      />
    )
  }

  const urlValid = baseUrl === '' || /^https?:\/\//.test(baseUrl)
  const dirty =
    settings !== undefined &&
    (baseUrl !== settings.sttBaseUrl ||
      model !== settings.sttModel ||
      secret !== settings.sttSecret ||
      cleanupModel !== settings.sttCleanupModel)
  const secrets = secretList?.secrets ?? []

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!urlValid || !dirty) return
    // Un verdict de test affiché ne vaut que pour les réglages qu'il a testés.
    test.reset()
    update.mutate({
      sttBaseUrl: baseUrl,
      sttModel: model,
      sttSecret: secret,
      sttCleanupModel: cleanupModel,
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <SectionHeader title={t('stt.section.title')} description={t('stt.section.description')} />

      <Card>
        <CardHeader title={t('stt.provider.title')} icon={<Mic size={16} />} />
        <CardBody>
          <form onSubmit={submit} className="flex flex-col gap-4">
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  onClick={() => {
                    setBaseUrl(preset.baseUrl)
                    setModel(preset.model)
                    setCleanupModel(preset.cleanupModel)
                  }}
                  className={cx(
                    'rounded-md border px-2 py-0.5 text-xs transition-colors',
                    preset.baseUrl === baseUrl && preset.model === model
                      ? 'border-accent bg-accent-wash text-ink'
                      : 'border-line text-ink-faint hover:border-line-strong hover:text-ink-soft',
                  )}
                >
                  {preset.name}
                </button>
              ))}
            </div>

            <Field
              label={t('stt.baseUrl.label')}
              hint={t('stt.baseUrl.hint')}
              error={urlValid ? undefined : t('stt.baseUrl.invalid')}
              value={baseUrl}
              spellCheck={false}
              placeholder="https://api.mistral.ai/v1"
              onChange={(event) => setBaseUrl(event.target.value)}
            />

            <Field
              label={t('stt.model.label')}
              value={model}
              spellCheck={false}
              placeholder="voxtral-mini-latest"
              onChange={(event) => setModel(event.target.value)}
            />

            {secrets.length > 0 ? (
              <Select
                label={t('stt.secret.label')}
                value={secret}
                placeholder={t('stt.secret.placeholder')}
                options={secrets.map(({ name }) => ({
                  value: name,
                  label: name,
                  icon: <KeyRound size={14} />,
                }))}
                onChange={setSecret}
              />
            ) : (
              <Banner tone="info">
                {t('stt.secret.none')}{' '}
                <Link to="/settings/secrets" className="underline">
                  {t('stt.secret.manage')}
                </Link>
              </Banner>
            )}

            <Field
              label={t('stt.cleanupModel.label')}
              hint={t('stt.cleanupModel.hint')}
              icon={<Sparkles size={14} />}
              value={cleanupModel}
              spellCheck={false}
              placeholder="mistral-small-latest"
              onChange={(event) => setCleanupModel(event.target.value)}
            />

            {update.error instanceof ApiRequestError ? (
              <Banner tone="critical">{update.error.message}</Banner>
            ) : null}

            {test.error instanceof Error ? (
              <Banner tone="critical">{test.error.message}</Banner>
            ) : null}
            {test.data ? (
              <Banner tone="positive">
                {test.data.cleanupTested ? t('stt.test.okCleanup') : t('stt.test.ok')}
              </Banner>
            ) : null}

            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" disabled={!urlValid || !dirty || update.isPending}>
                {t('stt.save')}
              </Button>
              {/* Sur les réglages enregistrés et non sur le formulaire : tester des
                  valeurs que le serveur ne connaît pas encore validerait autre chose
                  que ce que la dictée utilisera. */}
              <Button
                type="button"
                variant="ghost"
                icon={<RadioTower size={14} />}
                disabled={
                  !settings?.sttBaseUrl ||
                  !settings.sttModel ||
                  !settings.sttSecret ||
                  dirty ||
                  test.isPending
                }
                onClick={() => test.mutate()}
              >
                {t('stt.test.button')}
              </Button>
            </div>
          </form>
        </CardBody>
      </Card>

      <Banner tone="info">{t('stt.how')}</Banner>
    </div>
  )
}
