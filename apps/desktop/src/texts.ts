import { app } from 'electron'

/**
 * The main process's few messages stay outside the web application's catalog
 * (`apps/web/src/lib/i18n`): they appear precisely when the server serving that
 * interface and catalog is not responding.
 */
const MESSAGES = {
  en: {
    diagnostics: 'Export Sillage diagnostics…',
    diagnosticsFailed: 'The diagnostic report could not be saved.',
    startFailed: 'Sillage could not start',
    startFailedReinstall: 'If this follows an update, reinstall Sillage from the downloaded package: it replaces this copy and keeps your data.',
    starting: 'Starting Sillage…',
    stopped: 'The Sillage server stopped unexpectedly.',
    stoppedDetail: 'Exit code {code}. The log is in {log}.',
    stillRunning: 'programs started by Sillage are still running ({processes}). Close them, then try again.',
    seeLog: 'The log is in {log}.',
    download: 'Download Sillage',
    restart: 'Restart',
    quit: 'Quit',
  },
  fr: {
    diagnostics: "Exporter le diagnostic Sillage…",
    diagnosticsFailed: "Le rapport de diagnostic n’a pas pu être enregistré.",
    startFailed: "Sillage n'a pas pu démarrer",
    startFailedReinstall: "Si cela suit une mise à jour, réinstallez Sillage depuis le paquet téléchargé : il remplace cette copie et conserve vos données.",
    starting: 'Démarrage de Sillage…',
    stopped: "Le serveur de Sillage s'est arrêté de façon inattendue.",
    stoppedDetail: 'Code de sortie {code}. Le journal est dans {log}.',
    stillRunning: 'des programmes lancés par Sillage tournent encore ({processes}). Fermez-les, puis réessayez.',
    seeLog: 'Le journal est dans {log}.',
    download: 'Télécharger Sillage',
    restart: 'Relancer',
    quit: 'Quitter',
  },
} as const

export function text(key: keyof (typeof MESSAGES)['en'], values: Record<string, string> = {}): string {
  const messages = app.getLocale().toLowerCase().startsWith('fr') ? MESSAGES.fr : MESSAGES.en
  return messages[key].replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
}
