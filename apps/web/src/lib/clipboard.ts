import { useCallback, useEffect, useState } from 'react'

/**
 * `navigator.clipboard` requires a secure context, like `crypto.randomUUID`. It is absent over
 * local-IP HTTP, disabling all copy buttons on mobile without fallback. Use deprecated but
 * universally supported `execCommand('copy')`, the only way to copy in insecure contexts.
 */
export async function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Permission denied: still try the fallback below.
    }
  }

  const staging = document.createElement('textarea')
  staging.value = text
  staging.setAttribute('readonly', '')
  staging.style.position = 'fixed'
  staging.style.opacity = '0'
  document.body.appendChild(staging)

  try {
    staging.select()
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    staging.remove()
  }
}

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copy with brief visual feedback shared by all copy buttons. Feedback is essential because copying
 * has no other visible effect and silent failure resembles a dead button.
 */
export function useCopy(): { state: CopyState; copy: (text: string) => void } {
  const [state, setState] = useState<CopyState>('idle')

  useEffect(() => {
    if (state === 'idle') return
    const timer = setTimeout(() => setState('idle'), 1500)
    return () => clearTimeout(timer)
  }, [state])

  const copy = useCallback((text: string) => {
    void copyText(text).then((ok) => setState(ok ? 'copied' : 'failed'))
  }, [])

  return { state, copy }
}
