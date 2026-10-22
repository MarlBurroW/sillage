import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'

type Visit = { projectId: string; path: string }

/** Navigation history local to the account, never agent update history. */
export function useProjectVisits(userId: string) {
  const { pathname } = useLocation()
  const key = `sillage.projectVisits:${userId}`
  const [revision, setRevision] = useState(0)
  const visits = useMemo((): Visit[] => {
    void revision // Invalidate after local writes.
    try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? '[]')
      if (!Array.isArray(value)) return []
      return value.filter((entry): entry is Visit => entry && typeof entry.projectId === 'string' && typeof entry.path === 'string' && /^\/p\/[\w-]+\/(board|c\/[\w-]+)$/.test(entry.path) && entry.path.split('/')[2] === entry.projectId)
    } catch { return [] }
  }, [key, revision])
  useEffect(() => {
    const match = /^\/p\/([\w-]+)\/(board|c\/[\w-]+)$/.exec(pathname)
    if (!userId || !match) return
    try {
      const next = [{ projectId: match[1], path: pathname }, ...visits.filter((entry) => entry.projectId !== match[1])].slice(0, 50)
      if (visits[0]?.path === pathname) return
      localStorage.setItem(key, JSON.stringify(next))
      setRevision((value) => value + 1)
    } catch { /* Navigation remains available without storage. */ }
  }, [key, pathname, userId, visits])
  return visits
}
