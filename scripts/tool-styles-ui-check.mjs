import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { chromium } from 'playwright'

const web = fileURLToPath(new URL('../apps/web/', import.meta.url))
const socket = createServer().listen(0, '127.0.0.1')
await once(socket, 'listening')
const port = socket.address().port
await new Promise((resolve) => socket.close(resolve))
const origin = `http://127.0.0.1:${port}`
const output = process.env.TOOLS_UI_OUTPUT ?? '/var/tmp/sillage-tools-integrated'
await mkdir(output, { recursive: true })
const vite = spawn(process.execPath, [web + 'node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: web, stdio: 'pipe' })
let diagnostics = ''
for (const stream of [vite.stdout, vite.stderr]) stream.on('data', (chunk) => { diagnostics = (diagnostics + chunk).slice(-6000) })
let browser
let appearance = { theme: 'dark', syntax: 'sillage', values: {} }
const errors = []

async function mount(page) {
  await page.goto(origin + '/__tools_check')
  await page.evaluate(async () => {
    const refresh = (await import('/@react-refresh')).default
    refresh.injectIntoGlobalHook(window)
    window.$RefreshReg$ = () => {}
    window.$RefreshSig$ = () => (type) => type
    window.__vite_plugin_react_preamble_installed__ = true
    document.documentElement.dataset.theme = 'dark'
    localStorage.setItem('sillage.locale', 'fr')
    await (await import('/src/lib/i18n/index.ts')).initLocale()
    await import('/src/styles/index.css')
    const React = (await import('/node_modules/.vite/deps/react.js')).default
    const { createRoot } = (await import('/node_modules/.vite/deps/react-dom_client.js')).default
    const source = await (await fetch('/src/lib/user-settings.ts')).text()
    const { QueryClient, QueryClientProvider } = await import(source.match(/from ["']([^"']*tanstack[^"']+)["']/)[1])
    const routerSource = await (await fetch('/src/routes/SettingsPage.tsx')).text()
    const { MemoryRouter } = await import(routerSource.match(/from ["']([^"']*react-router-dom[^"']+)["']/)[1])
    const { ToolStyleControls } = await import('/src/components/ToolStyleControls.tsx')
    const { ChatThread } = await import('/src/components/chat/ChatThread.tsx')
    const { useAppearanceSync } = await import('/src/lib/appearance-sync.ts')
    const { useThreadLayout } = await import('/src/lib/use-thread-layout.ts')
    const { TooltipProvider } = await import('/src/components/ui/Tooltip.tsx')
    const { buildRows } = await import('/src/lib/tool-rows.ts')
    const { toolOrigin, toolLabel } = await import('/src/lib/tool-presentation.ts')
    const { resolveToolStyle } = await import('/src/lib/tool-style.ts')
    const check = (value, message) => { if (!value) throw Error(message) }
    for (const name of ['mcp__sillage__read_memory', 'sillage/read_memory', 'sillage_read_memory']) check(toolLabel(name) === 'Lire la mémoire du projet', name)
    check(toolOrigin('github/issue_read').kind === 'mcp', 'Codex MCP')
    check(toolOrigin('mcp__git_hub__issue_read').server === 'git_hub', 'Claude MCP')
    check(toolOrigin('apply_patch').kind === 'native', 'Native underscores')
    check(resolveToolStyle('future-style') === 'inline', 'Unknown style fallback')
    const tool = (id, name = 'Read', status = 'done', parentToolCallId = null) => ({ kind: 'tool', id, name, ts: 0, input: { file_path: 'src/App.tsx', file: 'project.md', query: '#58' }, output: 'Output of ' + id, outputBytes: null, status, durationMs: status === 'running' ? null : 120, parentToolCallId })
    const message = (id, text, role = 'assistant') => ({ kind: 'message', id, role, ts: 0, seq: Number(id) || 100, blocks: [{ type: 'text', text }], streamingText: '', streamingThinking: '', parentToolCallId: null })
    const pair = [tool('a'), tool('b')]
    check(!buildRows(pair, null, true)[0].complete, 'Wait for text')
    check(buildRows([...pair, message('answer', 'Answer')], null, true)[0].complete, 'Text closes sequence')
    check(!buildRows([...pair, tool('active', 'Bash', 'running'), message('answer', 'Answer')], null, true)[0].complete, 'Parallel call still running')
    check(buildRows(pair, null, false)[0].complete, 'Idle history')
    check(buildRows([pair[0], tool('sub', 'Read', 'done', 'parent'), pair[1]], null, true)[0].tools.length === 2, 'Do not mix subagents')
    check(buildRows([...pair, tool('agent','Agent')], null, true)[1].kind === 'tool', 'Keep agent visible')
    check(buildRows([...pair, {...tool('scheduled', 'sillage/schedule_task'), input:{ check_script:'exit 0' }}],null,true)[1].kind==='tool','Keep approval visible')
    check(!buildRows([...pair, {...message('think',''), streamingThinking:'Thinking'}], null, true)[0].complete, 'Thinking is not text')
    check(buildRows([...pair, {...message('think',''), streamingThinking:'Thinking'},message('answer','Answer')], null, true)[0].complete, 'Text after thinking closes series')
    const history = Array.from({length:12}, (_,i) => message(String(i+1), 'Message antérieur '+i+'\n\n'+ 'Un paragraphe de conversation à relire. '.repeat(10)))
    const examples = [tool('sillage','sillage/read_memory'), tool('external','github/issue_read'), ...Array.from({length:17},(_,i)=>tool('native-'+i))]
    window.makeItems = (mode) => [...history, ...examples.map((t,i)=> mode==='running'&&i===examples.length-1?{...t,status:'running',durationMs:null}:t), ...(mode==='text'?[message('100','Le filtre est corrigé. Les tests passent.')]:[])]
    function Screen() {
      useAppearanceSync()
      const [items, setItems] = React.useState(window.makeItems('running'))
      const [following, setFollowing] = React.useState(true)
      const scroller = React.useRef(null)
      const lastTop = React.useRef(0)
      useThreadLayout(scroller, following)
      window.setItems = setItems
      window.follow = () => { setFollowing(true); scroller.current.scrollTop=scroller.current.scrollHeight }
      const rows = buildRows(items,null,true)
      return React.createElement('main',{className:'mx-auto flex h-dvh max-w-4xl flex-col p-3'},
        React.createElement('details',{id:'settings'},React.createElement('summary',null,'Apparence'),React.createElement(ToolStyleControls)),
        React.createElement('div',{id:'thread',ref:scroller,className:'min-h-0 flex-1 overflow-y-auto',onScroll:()=>{
          const node=scroller.current;const top=node.scrollTop
          if(node.scrollHeight-top-node.clientHeight<48)setFollowing(true)
          else if(top<lastTop.current-1)setFollowing(false)
          lastTop.current=top
        }},React.createElement('div',{className:'flex flex-col gap-3 p-3'},React.createElement(ChatThread,{rows,conversationId:'fixture',mayCollapseTools:following}))))
    }
    createRoot(document.getElementById('check')).render(React.createElement(QueryClientProvider,{client:new QueryClient({defaultOptions:{queries:{retry:false}}})},React.createElement(MemoryRouter,null,React.createElement(TooltipProvider,null,React.createElement(Screen)))))
  })
  await page.locator('#thread .sg-tool-running').waitFor()
}
async function context(width) {
  const context = await browser.newContext({viewport:{width,height:1000},serviceWorkers:'block'})
  const page = await context.newPage()
  page.on('pageerror',error=>errors.push(error.message))
  await page.route('**/__tools_check', route=>route.fulfill({contentType:'text/html',body:'<html><meta name="viewport" content="width=device-width, initial-scale=1"><body><div id="check"></div></body></html>'}))
  await page.route('**/api/me/settings', async route=>{
    if(route.request().method()==='PATCH')appearance=route.request().postDataJSON().appearance
    await route.fulfill({json:{appearance}})
  })
  return {context,page}
}
async function settle() { await delay(120) }
try {
  for(let i=0;i<150;i++){if(await fetch(origin).then(r=>r.ok).catch(()=>false))break;await delay(100)}
  browser=await chromium.launch({chromiumSandbox:true})
  for(const width of [1440,390]){
    const {page,context:ctx}=await context(width)
    await mount(page)
    await page.locator('#settings > summary').click()
    const choices=page.getByRole('group',{name:'Outils dans les conversations'})
    assert.equal(await choices.locator('button').count(),6)
    for(const [label,variant] of [['Lignes discrètes','inline'],['Chronologie','timeline'],['Par intention','intent'],['Aperçus utiles','cards'],['Console compacte','console'],['Classique','classic']]){
      await choices.getByRole('button',{name:new RegExp('^'+label)}).click()
      await page.locator('#thread .sg-tools-'+variant).first().waitFor()
      const heights=await page.locator('[data-tool-style-preview] .sg-tool-heading').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))
      assert.equal(new Set(heights).size,1,variant+' same density')
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({path:`${output}/${variant}-${width}.png`})
    }
    await delay(650)
    assert.equal(appearance.toolStyle,'classic','Preference sent to account')
    await choices.getByRole('button',{name:'Lignes discrètes Par défaut'}).click()
    await page.locator('#settings > summary').click()
    await page.evaluate(()=>window.follow());await settle()
    await page.evaluate(()=>window.setItems(window.makeItems('done')));await settle()
    assert.equal(await page.locator('#thread [data-folded="true"]').count(),0,'Done alone must not fold')
    await page.locator('#thread').evaluate(node=>{node.scrollTop-=300});await settle()
    const before=await page.locator('#thread').evaluate(n=>n.scrollTop)
    await page.evaluate(()=>window.setItems(window.makeItems('text')));await settle()
    assert.equal(await page.locator('#thread [data-folded="true"]').count(),0,'Reading delays fold')
    assert.ok(Math.abs(await page.locator('#thread').evaluate(n=>n.scrollTop)-before)<2,'Reading position unchanged')
    await page.evaluate(()=>window.follow());await settle()
    assert.equal(await page.locator('#thread [data-folded="true"]').count(),1,'Return to bottom folds')
    assert.ok(await page.locator('#thread').evaluate(n=>n.scrollHeight-n.clientHeight-n.scrollTop<2),'Remain at bottom')
    await page.locator('#thread .sg-tool-group-heading').click()
    await page.evaluate(()=>window.setItems([...window.makeItems('text'),{kind:'notice',id:'later',text:'Suite'}]));await settle()
    assert.equal(await page.locator('#thread [data-folded="true"]').count(),0,'Manual group opening respected')
    await mount(page)
    await page.locator('#thread [data-tool-id="sillage"] .sg-tool-heading').click()
    await page.evaluate(()=>window.setItems(window.makeItems('text')));await settle()
    assert.equal(await page.locator('#thread [data-folded="true"]').count(),0,'Opened tool protects sequence')
    assert.ok(await page.locator('#thread .sg-tool-detail').first().isVisible())
    assert.match(await page.locator('#thread .sg-tool-detail').first().innerText(),/sillage\/read_memory/)
    await mount(page)
    await page.locator('#thread').evaluate(node=>{node.scrollTop-=300});await settle()
    const anchor=await page.locator('#thread').evaluate(node=>{
      const rect=node.getBoundingClientRect()
      const element=[...node.querySelectorAll('[data-tool-id]')].find(e=>e.getBoundingClientRect().top>rect.top&&e.getBoundingClientRect().bottom<rect.bottom)
      return {id:element.dataset.toolId,top:element.getBoundingClientRect().top}
    })
    await page.evaluate(()=>window.setItems(items=>items.map(item=>item.id==='1'?{...item,blocks:[{type:'text',text:'Un contenu chargé plus tard. '.repeat(1000)}]}:item)))
    await settle()
    const after=await page.locator(`#thread [data-tool-id="${anchor.id}"]`).evaluate(e=>e.getBoundingClientRect().top)
    assert.ok(Math.abs(after-anchor.top)<2,'Anchor survives growth above the reader')
    // Un événement scroll peut arriver après le reflow mais avant ResizeObserver.
    await page.locator('#thread').evaluate(node=>{
      node.querySelector('[data-seq="1"]').style.paddingBottom='300px'
      void node.scrollHeight
      node.dispatchEvent(new Event('scroll'))
    })
    await settle()
    const afterEarlyScroll=await page.locator(`#thread [data-tool-id="${anchor.id}"]`).evaluate(e=>e.getBoundingClientRect().top)
    assert.ok(Math.abs(afterEarlyScroll-anchor.top)<2,'Resize-induced scroll must not replace the reading anchor')
    await page.emulateMedia({reducedMotion:'reduce'})
    await page.evaluate(()=>window.setItems(window.makeItems('running')));await settle()
    assert.equal(await page.locator('#thread .sg-tool-running .animate-spin').evaluate(e=>getComputedStyle(e).animationName),'none')
    await ctx.close()
  }
  // La préférence provient du compte au retour, même avec un cache navigateur vierge.
  appearance={...appearance,toolStyle:'timeline'}
  const fresh=await context(1000);await mount(fresh.page)
  await fresh.page.locator('#thread .sg-tools-timeline').first().waitFor()
  await fresh.context.close()
  assert.deepEqual(errors,[])
  console.log('OK: six styles, density, settings sync, live sequence, deferred collapse, scroll, manual opening, mobile and reduced motion.')
} catch(error){console.error(diagnostics);throw error}
finally{await browser?.close();vite.kill('SIGTERM');await once(vite,'exit').catch(()=>{})}
