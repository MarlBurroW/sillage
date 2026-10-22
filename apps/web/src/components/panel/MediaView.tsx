import { isAudioType } from '@sillage/protocol'
import { rawFileUrl } from '../../lib/files-io'
import type { WorkspaceScope } from '../../lib/workspace-scope'

/**
 * Native workspace audio/video playback. Stream chunks through Range-supporting file/raw without
 * client libraries. preload metadata displays duration without downloading full files before
 * playback.
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
