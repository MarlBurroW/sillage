import { isAudioType } from '@sillage/protocol'
import { rawFileUrl } from '../../lib/files-io'
import type { WorkspaceScope } from '../../lib/workspace-scope'

/**
 * Son ou vidéo du workspace, joué par la balise native.
 *
 * Rien à charger côté client : le navigateur lit le flux en tranches via la route
 * `file/raw`, qui répond aux requêtes `Range`. `preload="metadata"` suffit à afficher
 * la durée sans télécharger le fichier avant qu'on appuie sur lecture.
 */
export function MediaView({ scope, path, type }: { scope: WorkspaceScope; path: string; type: string }) {
  const src = rawFileUrl(scope, path)
  return (
    <div data-editor-file={path} tabIndex={-1} className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4 outline-none">
      {isAudioType(type) ? (
        <audio controls preload="metadata" src={src} className="w-full max-w-xl" title={path} />
      ) : (
        <video controls preload="metadata" src={src} className="max-h-full max-w-full rounded-md bg-black" title={path} />
      )}
    </div>
  )
}
