// Version courante depuis l'API GitHub. La page reste complète sans elle :
// l'API non authentifiée est limitée à 60 requêtes/heure par IP.
fetch('https://api.github.com/repos/MarlBurroW/sillage/releases/latest')
  .then((res) => (res.ok ? res.json() : null))
  .then((release) => {
    if (!release || !release.tag_name) return
    const badge = document.getElementById('version-badge')
    badge.querySelector('[data-version]').textContent =
      'v' + release.tag_name.replace(/^v/, '') + ' available'
    badge.href = release.html_url
    badge.hidden = false
  })
  .catch(() => {})

// Onglets d'installation.
const tabs = document.querySelectorAll('.tabs [role="tab"]')
tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    tabs.forEach((other) => other.setAttribute('aria-selected', String(other === tab)))
    document.querySelectorAll('.tab-panel').forEach((panel) => {
      panel.hidden = panel.dataset.panel !== tab.dataset.tab
    })
  })
})
