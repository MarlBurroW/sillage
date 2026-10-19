import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_ONBOARDING, type OnboardingAnswers, type OnboardingState } from '@sillage/protocol'
import { AccountStep } from '../components/onboarding/AccountStep'
import { AddressStep } from '../components/onboarding/AddressStep'
import { AgentsStep } from '../components/onboarding/AgentsStep'
import { AppearanceStep } from '../components/onboarding/AppearanceStep'
import { MemoryStep } from '../components/onboarding/MemoryStep'
import { ReadyStep } from '../components/onboarding/ReadyStep'
import { RulesStep } from '../components/onboarding/RulesStep'
import { WelcomeStep } from '../components/onboarding/WelcomeStep'
import { WorkStep } from '../components/onboarding/WorkStep'
import { OnboardingShell, type ShellStep, type StepGate, type StepProps } from '../components/onboarding/shell'
import { useAppearanceSync } from '../lib/appearance-sync'
import { useTranslate, type MessageKey } from '../lib/i18n'
import { useInstance } from '../lib/instance'
import { onboardingSteps, type OnboardingStepId } from '../lib/onboarding'
import { useProjects } from '../lib/projects'
import { useCurrentUser } from '../lib/session'
import { useUpdateOnboarding, useUserSettings } from '../lib/user-settings'

const STEPS: Record<OnboardingStepId, (props: StepProps) => React.ReactElement> = {
  account: AccountStep,
  welcome: WelcomeStep,
  appearance: AppearanceStep,
  agents: AgentsStep,
  work: WorkStep,
  memory: MemoryStep,
  rules: RulesStep,
  address: AddressStep,
  ready: ReadyStep,
}

const SUBTITLES: Record<OnboardingStepId, MessageKey> = {
  account: 'onboarding.step.account.sub',
  welcome: 'onboarding.step.welcome.sub',
  appearance: 'onboarding.step.appearance.sub',
  agents: 'onboarding.step.agents.sub',
  work: 'onboarding.step.work.sub',
  memory: 'onboarding.step.memory.sub',
  rules: 'onboarding.step.rules.sub',
  address: 'onboarding.step.address.sub',
  ready: 'onboarding.step.ready.sub',
}

/** La synchronisation d'apparence vit dans la coquille, absente ici : montée à part, avec un compte. */
function AppearanceSyncGate() {
  useAppearanceSync()
  return null
}

/**
 * La visite de première ouverture.
 *
 * Deux régimes : sans compte en base, la page est la seule de l'application et son
 * état vit en local jusqu'à la création du compte ; avec une session, l'état est celui
 * des réglages du compte, et chaque pas y est écrit pour reprendre où l'on en était,
 * sur cet appareil ou un autre.
 */
export function OnboardingPage() {
  const t = useTranslate()
  const { data: user } = useCurrentUser()
  const { data: instance } = useInstance()
  const { data: settings } = useUserSettings(Boolean(user))
  const { data: projects } = useProjects()
  const update = useUpdateOnboarding()
  const [local, setLocal] = useState<OnboardingState>({ ...DEFAULT_ONBOARDING, pending: true })

  const state = user ? (settings?.onboarding ?? DEFAULT_ONBOARDING) : local
  const profile = instance?.profile ?? 'server'
  // Sans compte, c'est le premier : il sera administrateur.
  const isAdmin = user?.isAdmin ?? true
  const steps = onboardingSteps({ profile, isAdmin, answers: state.answers })
  const index = Math.min(state.step, steps.length - 1)
  const current = steps[index] ?? 'welcome'
  const last = index === steps.length - 1

  const commit = useRef<(() => Promise<void>) | null>(null)
  /*
   * La garde porte le nom de l'étape qui l'a posée : celle d'une étape quittée ne vaut
   * plus, sans qu'un effet ait à l'effacer. Un effet du parent qui remettait la garde à
   * zéro passait après celui de l'étape montée, et annulait sa première garde (19 oct.).
   */
  const currentRef = useRef(current)
  currentRef.current = current
  const [gateState, setGateState] = useState<{ step: OnboardingStepId; gate: StepGate }>({ step: current, gate: {} })
  const setGate = useCallback((next: StepGate) => setGateState({ step: currentRef.current, gate: next }), [])
  const gate = gateState.step === current ? gateState.gate : {}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Une erreur appartient à l'étape qui l'a produite.
  useEffect(() => {
    setError(null)
  }, [current])

  const persist = (patch: Partial<OnboardingState>) => {
    const next = { ...state, ...patch }
    if (user) update.mutate(next)
    else setLocal(next)
  }
  const setAnswers = (patch: Partial<OnboardingAnswers>) => persist({ answers: { ...state.answers, ...patch } })

  // La visite ne crée pas de projet : elle y mène, quand il n'y en a encore aucun. La
  // destination se joue dans `App` (route /bienvenue hors visite), dès que la visite
  // n'est plus due : naviguer d'ici arriverait après le démontage de cette page.
  const noProject = projects !== undefined && projects.length === 0
  const finish = () => update.mutate({ ...state, pending: false, step: 0 })

  const visited = (...ids: OnboardingStepId[]) => [...new Set([...state.visited, ...ids])]
  const next = async () => {
    setBusy(true)
    setError(null)
    try {
      await commit.current?.()
      if (last) finish()
      else persist({ step: index + 1, visited: visited(current), skipped: state.skipped.filter((id) => id !== current) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  const later = () => persist({ step: index + 1, visited: visited(current), skipped: [...new Set([...state.skipped, current])] })
  const back = () => persist({ step: Math.max(0, index - 1) })
  // En arrière librement ; en avant jusqu'à l'étape qui suit la dernière traversée : celle
  // qu'on avait sous les yeux avant de revenir en arrière, sans la marquer faite.
  const reachable = (target: number) =>
    target <= index ||
    state.visited.includes(steps[target] ?? 'ready') ||
    (target > 0 && state.visited.includes(steps[target - 1] ?? 'ready'))
  const goto = (target: number) => {
    if (reachable(target)) persist({ step: target })
  }
  // Tout sauter mène au récapitulatif ; le compte, lui, est déjà fait.
  const skipAll = () => {
    const rest = steps.slice(index, -1).filter((id) => id !== 'account')
    persist({ step: steps.length - 1, visited: visited(...rest), skipped: [...new Set([...state.skipped, ...rest])] })
  }

  const titleOf = (id: OnboardingStepId): string => {
    if (id === 'account') return t(user && !user.isAdmin ? 'onboarding.step.account.member' : 'onboarding.step.account.create')
    if (id === 'address') {
      if (!isAdmin) return t('onboarding.step.address.phone')
      return t(state.answers.devices === 'phone' ? 'onboarding.step.address.both' : 'onboarding.step.address.address')
    }
    return t(`onboarding.step.${id}` as MessageKey)
  }
  const shellSteps: ShellStep[] = steps.map((id, i) => ({
    id,
    title: titleOf(id),
    sub: t(SUBTITLES[id]),
    status:
      i === index
        ? 'current'
        : i < index || state.visited.includes(id)
          ? state.skipped.includes(id)
            ? 'skipped'
            : 'done'
          : 'todo',
    reachable: reachable(i),
  }))

  const nextLabel =
    current === 'account'
      ? t(user ? (user.isAdmin ? 'onboarding.shell.continue' : 'onboarding.shell.save') : 'onboarding.shell.createAccount')
      : current === 'welcome'
        ? t('onboarding.shell.start')
        : last
          ? t(noProject ? 'onboarding.shell.createProject' : 'onboarding.shell.finish')
          : t('onboarding.shell.continue')

  const Step = STEPS[current]

  return (
    <>
      {user ? <AppearanceSyncGate /> : null}
      <OnboardingShell
        steps={shellSteps}
        index={index}
        onGoto={goto}
        onSkipAll={skipAll}
        onBack={back}
        onNext={() => void next()}
        onLater={later}
        nextLabel={nextLabel}
        pending={busy || update.isPending}
        canContinue={gate.canContinue ?? true}
        laterAllowed={gate.laterAllowed ?? false}
        skipAllowed={Boolean(user) && (gate.skipAllowed ?? true) && !last}
        error={error}
      >
        <Step
          key={current}
          nav={{ commit, setGate }}
          state={state}
          update={persist}
          setAnswers={setAnswers}
          profile={profile}
          user={user ?? null}
          hostname={instance?.hostname ?? ''}
          homeDir={instance?.homeDir ?? ''}
        />
      </OnboardingShell>
    </>
  )
}
