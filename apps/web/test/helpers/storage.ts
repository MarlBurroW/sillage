/**
 * In-memory `localStorage` for modules that remember per-browser habits. Node 22 only exposes Web
 * Storage behind a flag, and a shim kept here leaves production code untouched. Installed on
 * import; `resetStorage()` gives each test a clean browser.
 */
const entries = new Map<string, string>()

const storage: Storage = {
  get length() {
    return entries.size
  },
  key: (index) => [...entries.keys()][index] ?? null,
  getItem: (key) => entries.get(key) ?? null,
  setItem: (key, value) => {
    entries.set(key, String(value))
  },
  removeItem: (key) => {
    entries.delete(key)
  },
  clear: () => entries.clear(),
}

Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true })

export function resetStorage(): void {
  entries.clear()
}
