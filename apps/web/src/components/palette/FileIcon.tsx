import { File } from 'lucide-react'
import { useEffect, useState } from 'react'

let icons: Promise<typeof import('../../lib/file-icons')> | null = null

/**
 * Icône d'un fichier, chargée à part.
 *
 * La table de correspondance de VS Code pèse près de 300 Ko : importée ici, elle entrait
 * dans le paquet principal, que la palette partage avec tout l'écran, et le faisait
 * dépasser ce que le service worker accepte de mettre en cache. Le panneau la charge déjà
 * de son côté ; en attendant, une icône générique tient la place.
 */
export function FileIcon({ name }: { name: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    icons ??= import('../../lib/file-icons')
    void icons.then((module) => {
      if (alive) setUrl(module.fileIconUrl(name, false))
    })
    return () => {
      alive = false
    }
  }, [name])

  return url ? <img src={url} alt="" className="size-[15px]" /> : <File size={15} />
}
