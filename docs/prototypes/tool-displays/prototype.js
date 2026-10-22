const proposals = [
 {id:'inline',name:'Lignes discrètes',desc:'Les outils prennent peu de place. La conversation reste le premier niveau de lecture.',trade:'Très léger à relire ; les résultats demandent un clic.'},
 {id:'timeline',name:'Chronologie',desc:'Un fil vertical relie les actions. On voit le cheminement de l’agent et où il en est.',trade:'Facile à suivre en direct ; un peu plus haut dans le fil.'},
 {id:'grouped',name:'Par intention',desc:'La recherche et la vérification se replient en étapes. La modification reste visible.',trade:'Utile sur les longs tours ; les titres d’étape sont à déduire des appels.'},
 {id:'cards',name:'Aperçus utiles',desc:'Chaque outil montre un petit résultat : lignes trouvées, diff ou sortie de commande.',trade:'Plus informatif sans ouvrir ; occupe davantage de place.'},
 {id:'console',name:'Console compacte',desc:'Une seule zone technique rassemble les appels, avec commandes et chemins au premier plan.',trade:'Dense et directe ; plus technique à lire.'},
 {id:'original',name:'Actuel · repère',desc:'La présentation actuelle, reconstituée ici pour comparer avec les cinq pistes.',trade:'Une carte par appel, nom de l’outil et résumé sur une ligne.'}
];
let state='running', view='gallery', selected='inline', expanded=false, grouping='separate';
let replayStep=null, replayTimer=null, policy='after-text';
const states={running:['◌','En cours','Je vérifie que les tests passent avec le nouveau filtre.'],done:['✓','Réussi','Le filtre est corrigé. Les 12 tests passent.'],failed:['!','En erreur','Un test échoue encore sur les sessions archivées. Je vais examiner ce cas.'],interrupted:['⊘','Interrompu','La vérification a été interrompue avant de produire un résultat.']};
const sillageLogo='<svg class="sillage-logo" viewBox="0 0 100 100" fill="currentColor" aria-hidden="true"><path d="M4 79C28 79 20 21 46 21H59C35 21 43 79 17 79Z"/><path d="M23 79C47 79 39 21 65 21H78C54 21 62 79 36 79Z"/><path d="M42 79C66 79 58 21 84 21H97C73 21 81 79 55 79Z"/></svg>';
const mcpIcon='<span class="mcp-mark" aria-label="Outil MCP externe">MCP</span>';
const calls=[
 {name:'mcp__sillage__list_cards',verb:'Consulter le board',sillage:true,target:'Sessions archivées',duration:'0,2 s',input:'{"status":"todo"}',output:'Carte #58 · Corriger le filtre des sessions archivées\nLe filtre doit permettre de retrouver les sessions archivées.\nProjet : Sillage',peek:'Carte #58 retrouvée · contexte du problème'},
 {name:'mcp__sillage__read_memory',verb:'Lire la mémoire du projet',sillage:true,target:'Filtres de la liste',duration:'0,1 s',input:'{"file":"session-filters.md"}',output:'Préférence retenue : masquer les archives par défaut.\nLe filtre Archives permet de les inclure à la demande.',peek:'Une décision du projet retrouvée'},
 {name:'mcp__github__issue_read',verb:'Lire le ticket',mcp:'GitHub',target:'sillage · #58',duration:'0,4 s',input:'{"method":"get","owner":"marlburrow","repo":"sillage","issue_number":58}',output:'#58 · Le filtre ne montre pas les sessions archivées\nSignalement : le problème apparaît après avoir activé Archives.\nÉtat : ouvert',peek:'Signalement GitHub retrouvé · ticket ouvert'},
 {name:'Grep',verb:'Rechercher',icon:'⌕',target:'isArchived',duration:'0,3 s',input:'rg -n "isArchived" apps/web/src',output:'SessionList.tsx:42  sessions.filter(s => !s.isArchived)\nSessionList.tsx:89  toggleArchived(session.id)',peek:'2 occurrences dans SessionList.tsx'},
 {name:'Read',verb:'Lire',icon:'▤',target:'SessionList.tsx',duration:'0,1 s',input:'apps/web/src/components/SessionList.tsx · lignes 35–58',output:'const visible = sessions.filter(session => {\n  return !session.isArchived\n})',peek:'24 lignes lues · filtre des sessions'},
 {name:'Edit',verb:'Modifier',icon:'⌁',target:'SessionList.tsx',duration:'0,2 s',input:'apps/web/src/components/SessionList.tsx',output:'<span class="minus">− return !session.isArchived</span>\n<span class="plus">+ return showArchived || !session.isArchived</span>',peek:'<span class="plus">+1</span> <span class="minus">−1</span> · filtre des sessions archivées'},
 {name:'Bash',verb:'Vérifier',icon:'›_',target:'pnpm test -- SessionList',duration:'2,4 s',input:'pnpm test -- SessionList',output:'',peek:''}
];
function tool(c,i,kind,overrideStatus){const last=c.name==='Bash';const branded=c.sillage&&kind!=='original';const external=c.mcp&&kind!=='original';const st=overrideStatus??(last?state:'done');const status=states[st];const output=last?({running:'RUN  SessionList.test.tsx\n✓ affiche les sessions actives\n✓ masque les sessions archivées\n… vérification du filtre',done:'✓ SessionList.test.tsx (12 tests)\nTest Files  1 passed\nTests       12 passed',failed:'FAIL  SessionList.test.tsx\n× affiche les archives quand le filtre est actif\nExpected: 3 sessions\nReceived: 2 sessions\nProcess exited with code 1',interrupted:'Exécution interrompue.\nAucun résultat final disponible.'}[st]):c.output;
 const peek=last?({running:'8 tests réussis · vérification en cours',done:'12 tests réussis',failed:'1 test échoue · sessions archivées',interrupted:'Vérification interrompue'}[st]):c.peek;
 return `<details class="tool ${st} ${branded?'sillage-tool':external?'mcp-tool':''}" ${expanded?'open':''}><summary><span class="tool-heading"><span class="chevron" aria-hidden="true">›</span>${branded?sillageLogo:external?mcpIcon:`<span class="icon" aria-hidden="true">${c.icon??'◇'}</span>`}<span class="tool-title">${branded||external?c.verb:['original','console'].includes(kind)?c.name:c.verb}</span>${external?`<span class="mcp-source">${c.mcp}</span>`:''}<span class="target" title="${c.target}">${c.target}</span><span class="meta">${branded?'<span class="sillage-tag">Sillage</span>':''}<span class="status ${st==='running'?'running-spinner':''}" aria-label="${status[1]}" title="${status[1]}">${st==='running'?'':status[0]}</span><span class="duration">${last&&st==='running'?'En cours':last&&st==='interrupted'?'Arrêté':c.duration}</span></span></span>${kind==='cards'?`<span class="peek">${peek}</span>`:''}</summary><div class="payload"><small>${c.name} · ${status[1]}</small><pre>${c.input}</pre><small>${c.name==='Edit'?'Modification':'Sortie'}</small><pre>${output}</pre></div></details>`;
}
function group(label,count,inner,open=false){return `<details class="group" ${open||expanded?'open':''}><summary><span class="chevron" aria-hidden="true">›</span><span class="group-title">${label}</span><span class="group-count">${count}</span></summary>${inner}</details>`}
// L’appel actif reste hors du groupe, comme dans le fil réel.
function groupedCalls(rows,kind,{members=calls,active=state==='running'}={}){
 const count=active?members.length-1:members.length;
 const issue=state==='failed'?'1 erreur':state==='interrupted'?'1 interrompu':'';
 const names=members.slice(0,Math.min(count,2)).map(c=>kind==='original'?c.name:c.verb).join(', ')+(count>2?`, +${count-2}`:'');
 const sillageCount=members.slice(0,count).filter(c=>c.sillage).length;
 const mcpCount=members.slice(0,count).filter(c=>c.mcp).length;
 const brand=kind==='original'?'':`${sillageCount?`<span class="batch-brand">${sillageLogo}${sillageCount} Sillage</span>`:''}${mcpCount?`<span class="batch-mcp">${mcpIcon}${mcpCount} · GitHub</span>`:''}`;
 const label=kind==='grouped'?'Examiner et corriger le filtre':`${count} outils`;
 const peek=kind==='cards'?`<span class="batch-peek">${members.slice(0,count).some(c=>c.name==='Edit')?'1 fichier modifié <span class="plus">+1</span> <span class="minus">−1</span>':'Contexte du projet consulté'}</span>`:'';
 return `<details class="batch ${state==='failed'?'has-error':''}" ${grouping==='open'||expanded?'open':''}><summary><span class="chevron" aria-hidden="true">›</span><span class="batch-title">${label}</span><span class="batch-names">${kind==='grouped'?`${count} outils`:names}</span>${brand}<span class="batch-meta">${issue?`<span class="batch-issue">${issue}</span>`:'<span class="status" aria-label="Réussis">✓</span>'}<span>${state==='interrupted'?'Arrêté':members.slice(0,count).reduce((sum,c)=>sum+parseFloat(c.duration.replace(',','.')),0).toFixed(1).replace('.',',')+' s'}</span></span>${peek}</summary><div class="batch-body">${rows.slice(0,count).join('')}</div></details>${active?rows.at(-1):''}`;
}
function sequenceContent(kind){
 const started=Math.min(calls.length,Math.ceil(replayStep/2));
 const completed=Math.min(calls.length,Math.floor(replayStep/2));
 const members=calls.slice(0,started);
 const rows=members.map((c,i)=>tool(c,i,kind,i<completed?'done':'running'));
 const collapse=policy==='immediate'?completed>=2:replayStep===15;
 if(!collapse)return rows.join('');
 const count=policy==='immediate'?completed:started;
 return groupedCalls(rows.slice(0,count),kind,{members:members.slice(0,count),active:false})+rows.slice(count).join('');
}
function stopReplay(){clearInterval(replayTimer);replayTimer=null;}
function updateReplay(){
 const active=replayStep!==null;
 document.querySelector('#grouping').disabled=active;
 document.querySelector('#state').disabled=active;
 document.querySelector('#play').textContent=replayTimer?'Pause':replayStep===15?'Rejouer':active?'Continuer':'Lire un enchaînement';
 document.querySelector('#replay-progress').value=replayStep??0;
 document.querySelector('#replay-status').textContent=!active?'Simulation : les appels arrivent un par un, se terminent, puis l’agent reprend la parole.':replayStep===0?'L’agent prépare son premier appel.':replayStep===15?'L’agent reprend la parole : la série est maintenant regroupée.':replayStep===14?'Tous les outils sont terminés. L’agent n’a pas encore repris la parole.':replayStep%2?`Appel ${Math.ceil(replayStep/2)} sur 7 en cours : ${calls[Math.floor(replayStep/2)].verb}.`:`${replayStep/2} outil(s) terminé(s). La série continue.`;
}
function advanceReplay(){
 replayStep=replayStep===null||replayStep===15?0:replayStep+1;
 state='done';grouping='closed';expanded=false;
 if(replayStep===15)stopReplay();
 render();
}
function render(){document.body.classList.toggle('focus',view==='focus');document.querySelector('#choices').innerHTML=proposals.map(p=>`<button data-choice="${p.id}" aria-pressed="${selected===p.id}">${p.name}</button>`).join('');document.querySelector('#gallery').innerHTML=proposals.map(p=>{
const rows=calls.map((c,i)=>tool(c,i,p.id));const content=replayStep!==null?sequenceContent(p.id):grouping!=='separate'?groupedCalls(rows,p.id):p.id==='grouped'?group(`${sillageLogo} Retrouver le contexte Sillage`,'2 outils',rows[0]+rows[1],true)+group(`${mcpIcon} Consulter le signalement`,'MCP · GitHub',rows[2],true)+group('Comprendre le filtre','2 outils · terminé',rows[3]+rows[4])+rows[5]+group('Vérifier la correction',states[state][1],rows[6],true):rows.join('');
return `<article class="${p.id} ${selected===p.id?'selected':''}" id="${p.id}"><div class="description"><h2>${p.name}</h2><p>${p.desc}</p><span class="tradeoff">${p.trade}</span><button class="use" data-focus="${p.id}">Voir cette piste dans le fil</button></div><div class="preview"><div class="preview-head"><span>Sillage / Corriger le filtre</span><span>Conversation fictive</span></div><div class="conversation"><p class="user">Tu peux corriger le filtre des sessions archivées ?</p><div class="agent-label">Sillage</div><p class="narration">Je retrouve le contexte dans Sillage et le signalement sur GitHub, puis je corrige le filtre.</p><div class="tools">${content}</div><p class="closing">${replayStep!==null?(replayStep===15?'J’ai corrigé la condition du filtre. Les 12 tests passent.':''):states[state][2]}</p></div></div></article>`}).join('');
 document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-pressed',b.dataset.view===view));document.querySelector('#expand').textContent=expanded?'Tout replier':'Tout déplier';updateReplay();
}
document.querySelector('#play').addEventListener('click',()=>{
 if(replayTimer){stopReplay();updateReplay();return;}
 if(replayStep===null||replayStep===15){replayStep=null;advanceReplay();}
 replayTimer=setInterval(advanceReplay,1400);updateReplay();
});
document.querySelector('#step').addEventListener('click',()=>{stopReplay();advanceReplay();});
document.querySelector('#reset').addEventListener('click',()=>{stopReplay();replayStep=null;state=document.querySelector('#state').value;grouping=document.querySelector('#grouping').value;render();});
document.querySelector('#policy').addEventListener('change',e=>{policy=e.target.value;render();});
document.querySelector('#grouping').addEventListener('change',e=>{grouping=e.target.value;expanded=false;render()});
document.querySelector('#state').addEventListener('change',e=>{state=e.target.value;render()});
document.querySelector('#expand').addEventListener('click',()=>{expanded=!expanded;if(grouping!=='separate'){grouping=expanded?'open':'closed';document.querySelector('#grouping').value=grouping;}render()});
document.querySelector('#theme').addEventListener('click',e=>{const light=document.documentElement.dataset.theme!=='light';document.documentElement.dataset.theme=light?'light':'dark';e.target.textContent=light?'Passer au thème sombre':'Passer au thème clair'});
document.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.view){view=b.dataset.view;render()}if(b.dataset.focus){selected=b.dataset.focus;view='focus';render();document.querySelector('#choices').scrollIntoView({block:'start',behavior:'instant'})}if(b.dataset.choice){selected=b.dataset.choice;render();if(view==='gallery')document.getElementById(selected).scrollIntoView({block:'start',behavior:'instant'})}});
render();
