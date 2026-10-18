import { app } from 'electron'

/**
 * Les quelques phrases du processus principal. Elles restent hors du catalogue de
 * l'application web (`apps/web/src/lib/i18n`) : elles s'affichent justement quand le
 * serveur, qui sert l'interface et ce catalogue, ne répond pas.
 */
const MESSAGES = {
  en: {
    startFailed: 'Sillage could not start',
    stopped: 'The Sillage server stopped unexpectedly.',
    stoppedDetail: 'Exit code {code}. The log is in {log}.',
    seeLog: 'The log is in {log}.',
    restart: 'Restart',
    quit: 'Quit',
  },
  fr: {
    startFailed: "Sillage n'a pas pu démarrer",
    stopped: "Le serveur de Sillage s'est arrêté de façon inattendue.",
    stoppedDetail: 'Code de sortie {code}. Le journal est dans {log}.',
    seeLog: 'Le journal est dans {log}.',
    restart: 'Relancer',
    quit: 'Quitter',
  },
} as const

export function text(key: keyof (typeof MESSAGES)['en'], values: Record<string, string> = {}): string {
  const messages = app.getLocale().toLowerCase().startsWith('fr') ? MESSAGES.fr : MESSAGES.en
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
}
