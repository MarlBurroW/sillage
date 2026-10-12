import { createServer } from 'node:http'
import { once } from 'node:events'

/**
 * Un faux GitHub, juste ce que le board relié appelle : issues, commentaires, `since`,
 * pagination. Pour les contrôles d'interface et les démonstrations, avec
 * `SILLAGE_GITHUB_API_URL` pointé dessus : rien ne part sur le vrai.
 *
 * `node scripts/fake-github.mjs [port]` le lance seul, avec quelques issues d'exemple.
 */
export async function startFakeGitHub({ port = 0, repo = 'acme/nimbus', seed = true, publicUrl = '' } = {}) {
  const issues = new Map()
  const comments = []
  let nextComment = 9000
  const now = () => Date.now()
  const iso = (ms) => new Date(ms).toISOString()
  const base = () => `http://127.0.0.1:${server.address().port}`
  // Les liens des issues mènent à la page du faux GitHub, pas au vrai, où elles n'existent pas.
  const page = (number, anchor = '') => publicUrl ? `${publicUrl}/#issue-${number}${anchor}` : `https://github.com/${repo}/issues/${number}${anchor}`

  const issueJson = (issue) => ({
    number: issue.number,
    html_url: page(issue.number),
    title: issue.title,
    body: issue.body,
    state: issue.state,
    state_reason: issue.state_reason,
    labels: issue.labels.map((name) => ({ name })),
    user: { login: issue.user },
    comments: comments.filter((comment) => comment.issue === issue.number).length,
    created_at: iso(issue.created),
    updated_at: iso(issue.updated),
    closed_at: issue.closed === null ? null : iso(issue.closed),
    ...(issue.pull ? { pull_request: {} } : {}),
  })
  const commentJson = (comment) => ({
    id: comment.id,
    html_url: page(comment.issue, `-comment-${comment.id}`),
    body: comment.body,
    user: { login: comment.user },
    created_at: iso(comment.created),
    updated_at: iso(comment.updated),
    issue_url: `${base()}/repos/${repo}/issues/${comment.issue}`,
  })

  const addIssue = (issue) => {
    const full = { body: '', state: 'open', state_reason: null, labels: [], user: 'someone', closed: null, ...issue, created: now(), updated: now() }
    issues.set(full.number, full)
    return full
  }
  const addComment = (issue, body, user = 'someone') => {
    const comment = { id: nextComment++, issue, body, user, created: now(), updated: now() }
    comments.push(comment)
    issues.get(issue).updated = now()
    return comment
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url, base())
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {}
    const send = (status, payload) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(payload))
    }
    // Une page pour jouer la communauté : ouvrir une issue, commenter, voir les réponses.
    if (url.pathname === '/' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return response.end(PAGE.replace('__REPO__', repo))
    }
    if (url.pathname === '/__fake/state') {
      const list = [...issues.values()].filter((issue) => !issue.pull).sort((a, b) => b.number - a.number)
      return send(200, list.map((issue) => ({ ...issueJson(issue), thread: comments.filter((comment) => comment.issue === issue.number).map(commentJson) })))
    }
    if (url.pathname === '/__fake/issue' && request.method === 'POST') {
      const number = Math.max(0, ...issues.keys()) + 1
      return send(201, issueJson(addIssue({ number, title: String(body.title || 'Untitled'), body: String(body.body ?? ''), user: String(body.user || 'someone') })))
    }
    if (url.pathname === '/__fake/comment' && request.method === 'POST') {
      if (!issues.has(Number(body.issue))) return send(404, { message: 'Not Found' })
      return send(201, commentJson(addComment(Number(body.issue), String(body.body ?? ''), String(body.user || 'someone'))))
    }

    const prefix = `/repos/${repo}`
    if (!url.pathname.startsWith(prefix)) return send(404, { message: 'Not Found' })
    const path = url.pathname.slice(prefix.length)
    const since = url.searchParams.get('since')
    const page = Number(url.searchParams.get('page') ?? 1)
    const paged = (list) => list.slice((page - 1) * 100, page * 100)
    const method = request.method

    if (path === '' && method === 'GET') return send(200, { full_name: repo, has_issues: true, permissions: { push: true } })
    if (path === '/issues' && method === 'GET') {
      const state = url.searchParams.get('state')
      const label = url.searchParams.get('labels')
      const list = [...issues.values()]
        .filter((issue) => state === 'all' || issue.state === state)
        .filter((issue) => !label || issue.labels.includes(label))
        .filter((issue) => !since || issue.updated >= Date.parse(since))
        .sort((a, b) => a.updated - b.updated)
      return send(200, paged(list.map(issueJson)))
    }
    if (path === '/issues' && method === 'POST') {
      const number = Math.max(0, ...issues.keys()) + 1
      return send(201, issueJson(addIssue({ number, title: body.title, body: body.body ?? '', labels: body.labels ?? [], user: 'you' })))
    }
    if (path === '/issues/comments' && method === 'GET') {
      return send(200, paged(comments.filter((comment) => !since || comment.updated >= Date.parse(since)).map(commentJson)))
    }
    const one = /^\/issues\/(\d+)(\/comments)?$/.exec(path)
    const issue = one ? issues.get(Number(one[1])) : undefined
    if (!issue) return send(404, { message: 'Not Found' })
    if (one[2] && method === 'GET') return send(200, paged(comments.filter((comment) => comment.issue === issue.number).map(commentJson)))
    if (one[2] && method === 'POST') return send(201, commentJson(addComment(issue.number, body.body, 'you')))
    if (method === 'GET') return send(200, issueJson(issue))
    if (method === 'PATCH') {
      if (typeof body.title === 'string') issue.title = body.title
      if (typeof body.body === 'string') issue.body = body.body
      if (Array.isArray(body.labels)) issue.labels = body.labels
      if (body.state === 'closed' && issue.state === 'open') issue.closed = now()
      if (body.state === 'open') issue.closed = null
      if (body.state) {
        issue.state = body.state
        issue.state_reason = body.state === 'closed' ? (body.state_reason ?? 'completed') : null
      }
      issue.updated = now()
      return send(200, issueJson(issue))
    }
    return send(405, { message: 'Method not allowed' })
  })
  server.listen(port, '127.0.0.1')
  await once(server, 'listening')

  if (seed) {
    const day = 86_400_000
    addIssue({ number: 12, title: 'Crash when the cache folder is missing', user: 'lena-k', labels: ['bug'], body: 'Nimbus crashes on startup if `~/.cache/nimbus` was deleted.\n\n**Steps**\n1. Delete the cache folder\n2. Start Nimbus\n\nVersion 2.3.1, macOS 15.' })
    addIssue({ number: 15, title: 'Support for proxy environment variables', user: 'tomasz', labels: ['enhancement'], body: 'Behind a corporate proxy, HTTPS_PROXY is ignored.' })
    addIssue({ number: 18, title: 'Dark mode for the dashboard', user: 'amir', labels: ['enhancement', 'in progress'], body: 'The dashboard is very bright at night.' })
    addIssue({ number: 21, title: 'Typo in the README install section', user: 'ghost-writer', labels: ['docs'], body: '`npm instal` should be `npm install`.' })
    addIssue({ number: 9, title: 'Export to CSV drops the last row', user: 'lena-k', state: 'closed', state_reason: 'completed', closed: now() - 3 * day, labels: ['bug'] })
    addIssue({ number: 3, title: 'Very old closed issue', user: 'someone', state: 'closed', state_reason: 'completed', closed: now() - 90 * day })
    addIssue({ number: 22, title: 'Bump dependencies', user: 'bot', pull: true })
    addComment(12, 'Same here on Linux, Nimbus 2.3.0.', 'marco-p')
    addComment(12, 'I can reproduce it, the folder is never recreated.', 'lena-k')
    addComment(18, 'Would love this too!', 'amir')
  }

  return {
    url: base(),
    issues,
    comments,
    addIssue,
    addComment,
    edit: (number, change) => Object.assign(issues.get(number), change, { updated: now() }),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

const PAGE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Faux GitHub · __REPO__</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; background: #f6f8fa; color: #1f2328 }
  main { max-width: 820px; margin: 0 auto; padding: 24px 16px 80px }
  h1 { font-size: 20px } .muted { color: #59636e; font-size: 13px }
  .box { background: #fff; border: 1px solid #d1d9e0; border-radius: 8px; padding: 14px 16px; margin: 14px 0 }
  .comment { border-top: 1px solid #eef1f4; padding: 10px 0 } pre { white-space: pre-wrap; margin: 6px 0; font: inherit }
  input, textarea { width: 100%; box-sizing: border-box; font: inherit; padding: 8px; border: 1px solid #d1d9e0; border-radius: 6px; margin: 4px 0 }
  button { font: inherit; padding: 6px 14px; border-radius: 6px; border: 1px solid #1f883d; background: #1f883d; color: #fff; cursor: pointer }
  .tag { display: inline-block; font-size: 12px; padding: 1px 8px; border-radius: 99px; background: #ddf4ff; color: #0969da; margin-left: 6px }
  .closed { background: #f6e8ff; color: #8250df } .row { display: flex; gap: 8px } .row input { flex: 0 0 160px }
</style></head><body><main>
<h1>Faux GitHub · __REPO__</h1>
<p class="muted">Pour essayer le board relié sans toucher au vrai GitHub. Ce qui porte la marque de session de Sillage est signalé « Sillage » ; tout le reste compte comme venu de l'extérieur.</p>
<form class="box" id="new"><strong>Ouvrir une issue</strong>
  <div class="row"><input name="user" value="lena-k" aria-label="Auteur"><input name="title" placeholder="Titre" required style="flex:1"></div>
  <textarea name="body" rows="3" placeholder="Description"></textarea><button>Ouvrir l'issue</button></form>
<div id="issues"></div></main>
<script>
const marker = /<!--\\s*sillage:session=[0-9a-f-]{36}\\s*-->/gi
const esc = (text) => String(text ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c])
const shown = (text) => esc(String(text ?? '').replace(marker, '').trimEnd())
const tag = (text) => marker.test(text ?? '') ? (marker.lastIndex = 0, '<span class="tag">Sillage</span>') : ''
async function load() {
  const list = await (await fetch('/__fake/state')).json()
  document.getElementById('issues').innerHTML = list.map((issue) => \`
    <section class="box" id="issue-\${issue.number}"><strong>#\${issue.number} \${esc(issue.title)}</strong>
      <span class="tag \${issue.state === 'closed' ? 'closed' : ''}">\${issue.state}\${issue.state_reason ? ' · ' + issue.state_reason : ''}</span>\${tag(issue.body)}
      \${issue.labels.map((label) => '<span class="tag">' + esc(label.name) + '</span>').join('')}
      <div class="muted">@\${esc(issue.user.login)}</div><pre>\${shown(issue.body)}</pre>
      \${issue.thread.map((c) => '<div class="comment" id="issue-' + issue.number + '-comment-' + c.id + '"><span class="muted">@' + esc(c.user.login) + '</span>' + tag(c.body) + '<pre>' + shown(c.body) + '</pre></div>').join('')}
      <form data-issue="\${issue.number}"><div class="row"><input name="user" value="lena-k" aria-label="Auteur"><input name="body" placeholder="Commenter" required style="flex:1"></div><button>Commenter</button></form>
    </section>\`).join('')
  for (const form of document.querySelectorAll('form[data-issue]')) form.onsubmit = (event) => send(event, '/__fake/comment', { issue: form.dataset.issue })
}
async function send(event, path, extra = {}) {
  event.preventDefault()
  const data = Object.fromEntries(new FormData(event.target))
  await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...data, ...extra }) })
  event.target.reset(); load()
}
document.getElementById('new').onsubmit = (event) => send(event, '/__fake/issue')
load(); setInterval(() => { if (!document.activeElement || !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) load() }, 5000)
</script></body></html>`

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const github = await startFakeGitHub({ port: Number(process.argv[2] ?? 0), publicUrl: process.env.FAKE_GITHUB_PUBLIC_URL ?? '' })
  console.log(`Faux GitHub (acme/nimbus) sur ${github.url}`)
}
