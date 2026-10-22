import { File } from 'lucide-react'
import { useEffect, useState } from 'react'

let icons: Promise<typeof import('../../lib/file-icons')> | null = null

/**
 * Lazy file icon. VS Code matching tables approach 300 KB; importing directly inflated the shared
 * main bundle beyond service-worker cache limits. The panel loads it separately; use generic icons
 * meanwhile.
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
