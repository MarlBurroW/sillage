(() => {
  const controls = document.querySelector('[data-catalog-controls]')
  const search = document.getElementById('feature-search')
  const edition = document.getElementById('feature-edition')
  const resultCount = document.getElementById('catalog-result-count')
  const empty = document.querySelector('[data-catalog-empty]')
  const clearSearch = document.querySelector('[data-clear-search]')
  if (!controls || !search || !edition || !resultCount || !empty || !clearSearch) return

  // The French page is built from this one; only the count below is written by this script.
  const french = document.documentElement.lang === 'fr'
  const normalize = (value) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
  const categories = [...document.querySelectorAll('[data-feature-category]')]
  const links = [...document.querySelectorAll('[data-category]')]
  const features = [...document.querySelectorAll('[data-feature]')].map((element) => ({
    element,
    category: element.closest('[data-feature-category]').id,
    edition: element.dataset.editions,
    text: normalize(`${element.textContent} ${element.dataset.keywords || ''}`),
  }))
  // The stylesheet hides the no-script notice once the filters work.
  document.documentElement.setAttribute('data-catalog-ready', '')
  const autoOpened = new Set()
  let category = 'all'

  function currentTarget() {
    try { return document.getElementById(decodeURIComponent(location.hash.slice(1))) } catch { return null }
  }

  function writeUrl({ push = false, hash } = {}) {
    const url = new URL(location.href)
    if (search.value.trim()) url.searchParams.set('q', search.value.trim())
    else url.searchParams.delete('q')
    if (edition.value !== 'all') url.searchParams.set('edition', edition.value)
    else url.searchParams.delete('edition')
    if (hash !== undefined) url.hash = hash
    if (url.href !== location.href) history[push ? 'pushState' : 'replaceState'](null, '', url)
  }

  function applyFilters() {
    const words = normalize(search.value.trim()).split(/\s+/).filter(Boolean)
    const counts = new Map(categories.map((group) => [group.id, 0]))
    let total = 0
    features.forEach(({ element, category: group, edition: available, text }) => {
      const matches = (edition.value === 'all' || available === 'both' || available === edition.value) && words.every((word) => text.includes(word))
      if (matches) counts.set(group, counts.get(group) + 1)
      const visible = matches && (category === 'all' || group === category)
      element.hidden = !visible
      if (visible) total++
      // Matching text may be in the explanation, so make it visible during a search.
      if (visible && words.length && !element.open) {
        element.open = true
        autoOpened.add(element)
      } else if (!words.length && autoOpened.has(element)) {
        element.open = false
        autoOpened.delete(element)
      }
    })
    categories.forEach((group) => {
      group.hidden = (category !== 'all' && category !== group.id) || counts.get(group.id) === 0
    })
    links.forEach((link) => {
      if (link.dataset.category === category) link.setAttribute('aria-current', 'true')
      else link.removeAttribute('aria-current')
      if (link.closest('.catalog-sidebar')) {
        const count = link.querySelector('.category-count')
        if (count) count.textContent = link.dataset.category === 'all'
          ? [...counts.values()].reduce((sum, number) => sum + number, 0)
          : counts.get(link.dataset.category)
      }
    })
    const filtered = words.length > 0 || edition.value !== 'all' || category !== 'all'
    resultCount.textContent = french
      ? `${total} ${total === 1 ? 'fonctionnalité' : 'fonctionnalités'}${filtered ? ` sur ${features.length}` : ' à découvrir'}`
      : `${total} ${total === 1 ? 'feature' : 'features'}${filtered ? ` of ${features.length}` : ' to explore'}`
    empty.hidden = total > 0
    clearSearch.hidden = !search.value
    document.querySelector('.catalog-results-bar [data-reset-filters]').hidden = !filtered
  }

  function restoreUrl({ scroll = false } = {}) {
    const params = new URL(location.href).searchParams
    search.value = params.get('q') || ''
    edition.value = ['desktop', 'server'].includes(params.get('edition')) ? params.get('edition') : 'all'
    const target = currentTarget()
    const feature = features.find(({ element }) => element === target)
    category = categories.some((group) => group === target) ? target.id : feature?.category || 'all'
    if (feature) {
      // A permanent feature link must remain useful even after a filtered search.
      search.value = ''
      edition.value = 'all'
    }
    applyFilters()
    if (feature) feature.element.open = true
    if (scroll && target && !target.hidden) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }))
    writeUrl()
  }

  function reset() {
    search.value = ''
    edition.value = 'all'
    category = 'all'
    writeUrl({ push: true, hash: 'catalog' })
    applyFilters()
    search.focus({ preventScroll: true })
  }

  links.forEach((link) => link.addEventListener('click', (event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    event.preventDefault()
    category = link.dataset.category
    writeUrl({ push: true, hash: category === 'all' ? 'catalog' : category })
    applyFilters()
    document.getElementById('catalog').scrollIntoView({ block: 'start' })
  }))
  search.addEventListener('input', () => {
    writeUrl({ hash: category === 'all' ? 'catalog' : category })
    applyFilters()
  })
  edition.addEventListener('change', () => {
    writeUrl({ push: true, hash: category === 'all' ? 'catalog' : category })
    applyFilters()
  })
  clearSearch.addEventListener('click', () => {
    search.value = ''
    writeUrl()
    applyFilters()
    search.focus({ preventScroll: true })
  })
  document.querySelectorAll('[data-reset-filters]').forEach((button) => button.addEventListener('click', reset))
  addEventListener('hashchange', () => restoreUrl({ scroll: true }))
  addEventListener('popstate', () => restoreUrl({ scroll: true }))
  // "/" jumps to the search, as on documentation sites, unless the reader is already typing.
  addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return
    const target = event.target
    if (target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return
    event.preventDefault()
    search.focus()
    search.select()
  })
  controls.hidden = false
  restoreUrl({ scroll: Boolean(location.hash) })
})()
