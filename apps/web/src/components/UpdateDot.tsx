/**
 * La pastille d'une mise à jour en attente, posée dans le coin d'une icône dont le
 * parent est en `relative`. Une pastille, pas un toast : la mise à jour attend sans
 * presser, elle doit seulement se voir depuis n'importe quel écran.
 */
export function UpdateDot() {
  return <span aria-hidden className="absolute -top-0.5 -right-0.5 size-1.5 rounded-full bg-accent" />
}
