// Keep the full set of links and explanations available before enhancement.
(() => {
  const filter = document.querySelector('[data-platform-filter]')
  const packages = [...document.querySelectorAll('[data-platform-group]')]
  const packageGrid = document.querySelector('.package-grid')
  if (filter && packages.length && packageGrid) {
    filter.addEventListener('click', (event) => {
      const button = event.target.closest('[data-platform]')
      if (!button) return
      const selected = button.dataset.platform
      filter.querySelectorAll('[data-platform]').forEach((option) => {
        option.setAttribute('aria-pressed', String(option === button))
      })
      packages.forEach((group) => { group.hidden = selected !== 'all' && group.dataset.platformGroup !== selected })
      packageGrid.toggleAttribute('data-filtered', selected !== 'all')
    })
    filter.hidden = false
  }

})()
