/**
 * The startup mark of `index.html` covers the wait before anything can render: the bundle,
 * the language catalog, the session check. Remove it once a first screen takes its place.
 */
export function dismissBootMark(): void {
  document.getElementById('boot')?.remove()
}
