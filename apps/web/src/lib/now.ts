import { useEffect, useState } from 'react'

/**
 * Current time, refreshed every `intervalMs`: often enough for the wall's sliding windows such as
 * `active:30m` by default, every second for a running clock.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(timer)
  }, [intervalMs])
  return now
}
