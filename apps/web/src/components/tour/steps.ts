import type { MessageKey } from '../../lib/i18n'

/**
 * The interface tour: a handful of bubbles shown once, on the first conversation after the
 * first-run tour, each pointing at a real element of the interface.
 *
 * A step names the element it points at; that element carries `tourAnchor(id)` where it is
 * rendered. The link is checked both ways by `apps/server/test/interface-tour.test.ts`, which runs
 * in CI: a step whose element lost its anchor fails there, as does an anchor no step uses. At run
 * time a step whose element is not on screen is left out, so the tour adapts by itself to the
 * phone (the menu button stands for the rail and the column) and never blocks on a missing piece.
 *
 * When the interface moves: keep the anchor on whatever now plays the role, reword the step if the
 * role changed, and drop the step when the thing is gone. `pnpm test:tour-ui` walks the tour on a
 * wide screen and on a phone.
 */
export const TOUR_STEPS = [
  // Phone only: the navigation lives in a drawer there.
  { id: 'menu', title: 'tour.step.menu.title', body: 'tour.step.menu.body' },
  { id: 'rail', title: 'tour.step.rail.title', body: 'tour.step.rail.body' },
  { id: 'column', title: 'tour.step.column.title', body: 'tour.step.column.body' },
  // New conversations only: an open one has its agent already.
  { id: 'agent', title: 'tour.step.agent.title', body: 'tour.step.agent.body' },
  { id: 'composer', title: 'tour.step.composer.title', body: 'tour.step.composer.body' },
  { id: 'panel', title: 'tour.step.panel.title', body: 'tour.step.panel.body' },
  { id: 'palette', title: 'tour.step.palette.title', body: 'tour.step.palette.body' },
] as const satisfies readonly { id: string; title: MessageKey; body: MessageKey }[]

export type TourStep = (typeof TOUR_STEPS)[number]
export type TourAnchor = TourStep['id']

/**
 * The tour waits for this element before it starts: explaining the composer over a settings page
 * or the project form would describe things that are not there.
 */
export const TOUR_START: TourAnchor = 'composer'

/** Where a personal conversation can always be started, so a replay has something to show. */
export const TOUR_REPLAY_PATH = '/discussions/new'

/** Spread on the element a step points at. */
export function tourAnchor(id: TourAnchor): { 'data-tour': TourAnchor } {
  return { 'data-tour': id }
}
