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
    window.presentationCases = [
      {...tool('codex-edit','Edit'), input:{changes:[{path:'apps/web/src/components/chat/ToolCall.tsx',kind:{type:'update',move_path:null},diff:'@@ -1 +1 @@\n-before\n+after'}]}},
      {...tool('codex-multi','Edit'), input:{changes:[{path:'src/App.tsx'},null,{path:42},{path:'src/styles.css'},{path:'src/App.tsx'}]}},
      {...tool('claude-edit','Edit'), input:{file_path:'src/legacy.ts',old_string:'keep\nbefore\nend',new_string:'keep\nafter\nextra\nend'}},
      {...tool('opencode-patch','ApplyPatch'), input:{patch:'*** Begin Patch\n*** Update File: src/styles.css\n@@\n-old\n+new\n+extra\n*** End Patch'}},
      {...tool('write','Write'), input:{file_path:'src/new.ts',content:'first\nsecond\nthird\n'}},
      {...tool('failed-write','Write','failed'), input:{file_path:'failed.ts',content:'first\n'}},
      {...tool('failed-edit','Edit','failed'), input:{file_path:'failed.ts',old_string:'before',new_string:'after'}},
      {...tool('bash-error','Bash','failed'), input:{command:'pnpm test'},output:'One test failed.'},
      {...tool('sillage-error','sillage/read_memory','failed'),output:'File not found.'},
      {...tool('mcp-error','github/issue_read','failed'),output:'Issue not found.'},
      {...tool('bash-success','Bash'), input:{command:'pnpm typecheck'}},
      {...tool('web-find','WebSearch'),input:{query:''},output:{query:"'stream-json'",action:{type:'findInPage',url:null,pattern:'stream-json'},results:[{type:'text_result',snippet:'Matching result'}]}},
      {...tool('web-multiple','WebSearch'),input:{type:'search',query:'',queries:['first query','second query']},output:{query:'',action:{type:'search',query:null,queries:['first query','second query']},results:[{snippet:'Multiple search result'}]}},
      {...tool('web-fetch','WebFetch'),input:{query:''},output:{query:'open',action:{type:'openPage',url:'https://example.com/docs'},results:[{snippet:'Page result'}]}},
      {...tool('web-lazy','WebSearch'),input:{query:''},output:null,outputRef:{seq:321,field:'output',bytes:1000}},
      {...tool('claude-description','Bash'),input:{command:'tail -20 test.log',description:'Lire le rapport des tests'},output:'Report body'},
      {...tool('harness-title','Bash'),input:{command:'pnpm test'},presentation:{title:'Vérifier les modifications'},output:'Tests passed'},
      {...tool('harness-location','Read'),input:{},presentation:{paths:['src/main.ts']}},
      {...tool('parsed-command','Bash'),input:{command:'/bin/zsh -lc cat src/a.ts',commandActions:[{type:'read',path:'src/a.ts',name:'a.ts'}]}},
      {...tool('task-id','TaskUpdate'),input:{taskId:'17',status:'completed'}},
      {...tool('skill-name','Skill'),input:{skill:'frontend-design'}},
      {...tool('dynamic-native','functions/custom'),input:{path:'src/a.ts'},presentation:{origin:'native'}},
      {...tool('connector-label','github/search'),input:{query:'bugs in the parser'},presentation:{origin:'mcp',label:'Rechercher des tickets'}},
      tool('active','Read','running'),
    ]
    window.makeItems = (mode) => [...history, ...examples.map((t,i)=> mode==='running'&&i===examples.length-1?{...t,status:'running',durationMs:null}:t), ...(mode==='text'?[message('100','Le filtre est corrigé. Les tests passent.')]:[])]
    function Screen() {
      useAppearanceSync()
      const [items, setItems] = React.useState(window.makeItems('running'))
      const [following, setFollowing] = React.useState(true)
      const scroller = React.useRef(null)
      const lastTop = React.useRef(0)
      window.threadLastTop = lastTop
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
  // Mounting commits the rows before ResizeObserver performs the initial follow-to-bottom.
  await page.waitForFunction(() => {
    const node = document.getElementById('thread')
    return node && node.scrollHeight - node.clientHeight - node.scrollTop < 2 && window.threadLastTop.current === node.scrollTop
  })
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
    let webBodyRequests = 0
    await page.route('**/api/conversations/fixture/events/321/body/output', route => {
      webBodyRequests++
      return route.fulfill({json:{value:{query:'loaded query',action:{type:'search',query:null,queries:null},results:[{snippet:'Loaded result'}]}}})
    })
    await page.evaluate(()=>window.setItems(window.presentationCases))
    for(const [label,variant] of [['Lignes discrètes','inline'],['Chronologie','timeline'],['Par intention','intent'],['Aperçus utiles','cards'],['Console compacte','console'],['Classique','classic']]){
      await choices.getByRole('button',{name:new RegExp('^'+label)}).click()
      await page.locator('#thread .sg-tools-'+variant).first().waitFor()
      const heights=await page.locator('[data-tool-style-preview] .sg-tool-heading').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().height))
      assert.equal(new Set(heights).size,1,variant+' same density')
      const heading = id => page.locator(`#thread [data-tool-id="${id}"] .sg-tool-heading`)
      assert.match(await heading('codex-edit').innerText(),/apps\/web\/src\/components\/chat\/ToolCall.tsx/)
      assert.match(await heading('codex-multi').innerText(),/src\/App.tsx · src\/styles.css/)
      assert.match(await heading('claude-edit').innerText(),/src\/legacy.ts/)
      assert.match(await heading('web-find').innerText(),/stream-json/)
      assert.match(await heading('web-multiple').innerText(),/first query · second query/)
      assert.match(await heading('web-fetch').innerText(),/https:\/\/example.com\/docs/)
      assert.equal(webBodyRequests,0,'Collapsed web calls must not fetch output bodies')
      assert.match(await heading('claude-description').innerText(),/Lire le rapport des tests/)
      assert.match(await heading('harness-title').innerText(),/Vérifier les modifications/)
      assert.match(await heading('connector-label').innerText(),/Rechercher des tickets/)
      assert.match(await heading('connector-label').innerText(),/bugs in the parser/)
      assert.match(await heading('harness-location').innerText(),/src\/main.ts/)
      assert.match(await heading('parsed-command').innerText(),/Lire src\/a.ts/)
      assert.match(await heading('task-id').innerText(),/#17/)
      assert.match(await heading('skill-name').innerText(),/frontend-design/)
      assert.equal(await heading('dynamic-native').locator('.sg-mcp-mark').count(),0,'Dynamic native tools are not MCP')
      for (const [id,expected] of [['codex-edit','+1−1'],['claude-edit','+2−1'],['opencode-patch','+2−1'],['write','+3']]) {
        assert.equal(await heading(id).locator('.sg-tool-counts').textContent(),expected)
        const badge=await heading(id).locator('.sg-tool-counts').boundingBox()
        const row=await heading(id).boundingBox()
        assert.ok(badge.x>=row.x && badge.x+badge.width<=row.x+row.width,variant+' visible counters on '+width)
      }
      assert.match(await heading('write').locator('.sg-tool-counts').getAttribute('aria-label'), /3 lignes écrites/)
      assert.equal(await heading('failed-write').locator('.sg-tool-counts').count(),0,'Failed writes do not claim written lines')
      assert.equal(await heading('failed-edit').locator('.sg-tool-counts').count(),0,'Failed edits do not claim applied changes')
      assert.equal(await heading('bash-error').getByRole('img',{name:'Échec',exact:true}).count(),1)
      assert.equal(await heading('bash-error').evaluate(e=>e.getBoundingClientRect().height),await heading('bash-success').evaluate(e=>e.getBoundingClientRect().height))
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({path:`${output}/${variant}-${width}.png`})
    }
    // Metadata updates must refresh the row even when arguments do not change.
    await page.evaluate(()=>window.setItems(items=>items.map(item=>item.id==='harness-title'?{...item,presentation:{title:'Relire le résultat des tests'}}:item)))
    await page.waitForFunction(()=>document.querySelector('[data-tool-id="harness-title"] .sg-tool-heading').textContent.includes('Relire le résultat des tests'))
    const described=page.locator('#thread [data-tool-id="claude-description"]')
    await described.locator('.sg-tool-heading').click()
    assert.match(await described.locator('.sg-tool-detail').innerText(),/tail -20 test.log/,'The actual command remains available behind the human description')
    await described.getByRole('button',{name:'Brut',exact:true}).click()
    assert.match(await described.locator('.sg-tool-detail').innerText(),/description/)
    await described.locator('.sg-tool-heading').click()
    // Historical web arguments recover from inline and lazily loaded final results.
    for (const [id, query, result] of [['web-find','stream-json','Matching result'],['web-multiple','first query','Multiple search result'],['web-fetch','https://example.com/docs','Page result'],['web-lazy','loaded query','Loaded result']]) {
      const row=page.locator(`#thread [data-tool-id="${id}"]`)
      await row.locator('.sg-tool-heading').click()
      await row.locator('.sg-tool-detail').getByText(result,{exact:false}).first().waitFor()
      assert.ok((await row.locator('.sg-tool-detail').innerText()).includes(query))
      await row.getByRole('button',{name:'Brut',exact:true}).click()
      const rawText=await row.locator('.sg-tool-detail').innerText()
      assert.ok(rawText.includes(query))
      assert.ok(!rawText.includes('"query": ""') || id==='web-multiple','Recovered raw input is no longer the empty start')
      await row.locator('.sg-tool-heading').click()
    }
    assert.equal(webBodyRequests,1,'Expanded legacy call loads its final output once')
    // Readable views and raw fallback share the same final payloads.
    await page.locator('#thread [data-tool-id="codex-edit"] .sg-tool-heading').click()
    assert.match(await page.locator('#thread [data-tool-id="codex-edit"] .sg-tool-detail').innerText(), /before/)
    await page.locator('#thread [data-tool-id="codex-edit"] .sg-tool-heading').click()
    await page.locator('#thread [data-tool-id="opencode-patch"] .sg-tool-heading').click()
    assert.match(await page.locator('#thread [data-tool-id="opencode-patch"] .sg-tool-detail').innerText(), /Begin Patch/)
    await page.locator('#thread [data-tool-id="opencode-patch"] .sg-tool-heading').click()
    await delay(650)
    assert.equal(appearance.toolStyle,'classic','Preference sent to account')
    await choices.getByRole('button',{name:'Lignes discrètes Par défaut'}).click()
    await page.locator('#settings > summary').click()
    await page.evaluate(()=>window.setItems(window.makeItems('running')));await settle()
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
    assert.ok(Math.abs(after-anchor.top)<2,`Anchor survives growth above the reader (${width}px, delta ${after-anchor.top})`)
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
  console.log('OK: six styles, human metadata, tool summaries, web inputs, lazy bodies, settings sync, grouping, scroll, mobile and reduced motion.')
} catch(error){console.error(diagnostics);throw error}
finally{await browser?.close();vite.kill('SIGTERM');await once(vite,'exit').catch(()=>{})}
