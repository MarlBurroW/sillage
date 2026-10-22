/**
 * Pending-update dot at the corner of a relatively positioned icon. A quiet badge rather than toast
 * keeps updates visible across screens without urgency.
 */
export function UpdateDot() {
  return <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />
}
