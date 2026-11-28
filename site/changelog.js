// Search the changelog: keep the releases whose notes mention every word typed, open their folded
// notes and mark the words. Without JavaScript the field stays hidden and every release shows.
(() => {
  const controls = document.querySelector('[data-changelog-search]')
  const search = document.getElementById('release-search')
  const clear = controls?.querySelector('[data-clear-search]')
  const status = document.getElementById('release-search-status')
  const empty = document.querySelector('[data-changelog-empty]')
  if (!controls || !search || !clear || !status || !empty) return

  const french = document.documentElement.lang === 'fr'
  const normalize = (value) => value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLocaleLowerCase()
  const entries = [...document.querySelectorAll('.release-entry')].map((element) => ({
    element,
    folded: element.querySelector('details.release-more'),
    text: normalize(element.textContent),
  }))
  const months = [...document.querySelectorAll('.release-month')]
  const jumps = [...document.querySelectorAll('.changelog-jump a')]
  const opened = new Set()
  // The Custom Highlight API marks words without touching the notes; older browsers just filter.
  const canMark = typeof Highlight === 'function' && 'highlights' in CSS

  function mark(words, visible) {
    if (!canMark) return
    CSS.highlights.delete('release-match')
    if (!words.length) return
    const ranges = []
    for (const { element } of visible) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.data.toLocaleLowerCase()
        for (const word of words) {
          for (let at = text.indexOf(word); at !== -1; at = text.indexOf(word, at + word.length)) {
            const range = new Range()
            range.setStart(node, at)
            range.setEnd(node, at + word.length)
            ranges.push(range)
          }
        }
      }
    }
    CSS.highlights.set('release-match', new Highlight(...ranges))
  }

  function apply() {
    const typed = search.value.trim()
    const words = normalize(typed).split(/\s+/).filter(Boolean)
    const visible = []
    for (const entry of entries) {
      const match = words.every((word) => entry.text.includes(word))
      entry.element.hidden = !match
      if (match) visible.push(entry)
      // A match may sit in folded notes: open them while searching, fold them back after.
      if (entry.folded && match && words.length && !entry.folded.open) {
        entry.folded.open = true
        opened.add(entry.folded)
      } else if (entry.folded && opened.has(entry.folded) && (!words.length || !match)) {
        entry.folded.open = false
        opened.delete(entry.folded)
      }
    }
    months.forEach((month) => { month.hidden = !month.querySelector('.release-entry:not([hidden])') })
    jumps.forEach((link) => { link.hidden = Boolean(document.getElementById(link.hash.slice(1))?.hidden) })
    clear.hidden = !search.value
    empty.hidden = visible.length > 0
    const count = visible.length
    status.textContent = !words.length ? '' : french
      ? `${count} ${count === 1 ? 'version correspond' : 'versions correspondent'}`
      : `${count} ${count === 1 ? 'release matches' : 'releases match'}`
    // Typed words, lowercased as typed: the marks follow the text, accents included.
    mark(typed.toLocaleLowerCase().split(/\s+/).filter(Boolean), visible)
  }

  function writeUrl() {
    const url = new URL(location.href)
    if (search.value.trim()) url.searchParams.set('q', search.value.trim())
    else url.searchParams.delete('q')
    if (url.href !== location.href) history.replaceState(null, '', url)
  }

  function reset() {
    search.value = ''
    writeUrl()
    apply()
    search.focus({ preventScroll: true })
  }

  search.addEventListener('input', () => {
    writeUrl()
    apply()
  })
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && search.value) {
      event.preventDefault()
      reset()
    }
  })
  clear.addEventListener('click', reset)
  empty.querySelector('[data-reset-search]')?.addEventListener('click', reset)
  // "/" jumps to the search, as on the feature catalog, unless the reader is already typing.
  addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    event.preventDefault()
    search.focus()
    search.select()
  })

  search.value = new URL(location.href).searchParams.get('q') || ''
  controls.hidden = false
  apply()
})()
