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

/** Appearance sync normally lives in the shell, absent here: mount it separately when signed in. */
function AppearanceSyncGate() {
  useAppearanceSync()
  return null
}

/**
 * First-open onboarding.
 *
 * Two modes: with no database account, this is the app's only page and state stays local until
 * account creation. With a session, state lives in account settings and every step is saved for
 * resuming here or on another device.
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
  // With no account, this is the first: it will be an administrator.
  const isAdmin = user?.isAdmin ?? true
  const steps = onboardingSteps({ profile, isAdmin, answers: state.answers })
  const index = Math.min(state.step, steps.length - 1)
  const current = steps[index] ?? 'welcome'
  const last = index === steps.length - 1

  const commit = useRef<(() => Promise<void>) | null>(null)
  /*
   * The guard carries its step name: leaving a step invalidates its guard without an effect
   * clearing it. A parent reset effect ran after the mounted step's effect and canceled its
   * initial guard (October 19).
   */
  const currentRef = useRef(current)
  currentRef.current = current
  const [gateState, setGateState] = useState<{ step: OnboardingStepId; gate: StepGate }>({ step: current, gate: {} })
  const setGate = useCallback((next: StepGate) => setGateState({ step: currentRef.current, gate: next }), [])
  const gate = gateState.step === current ? gateState.gate : {}
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // An error belongs to the step that produced it.
  useEffect(() => {
    setError(null)
  }, [current])

  const persist = (patch: Partial<OnboardingState>) => {
    const next = { ...state, ...patch }
    if (user) update.mutate(next)
    else setLocal(next)
  }
  const setAnswers = (patch: Partial<OnboardingAnswers>) => persist({ answers: { ...state.answers, ...patch } })

  // Onboarding does not create a project; it leads there when none exist. `App` handles
  // the destination (`/bienvenue` outside onboarding) once the tour is no longer due:
  // navigating here would occur after this page unmounts.
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
  // Freely go back; forward only as far as the step after the last visited one:
  // the step shown before going back, without marking it complete.
  const reachable = (target: number) =>
    target <= index ||
    state.visited.includes(steps[target] ?? 'ready') ||
    (target > 0 && state.visited.includes(steps[target - 1] ?? 'ready'))
  const goto = (target: number) => {
    if (reachable(target)) persist({ step: target })
  }
  // Skipping everything leads to the recap; the account is already created.
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
