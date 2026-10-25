import { STATUS } from '/shared/model.mjs';
import { validateCatalog, hashCatalog, hashItem, hex, parseAddress } from '/shared/catalog.mjs';
import { checkBuild } from '/shared/engine.mjs';
import { DEMO_CATALOG, createDemoRpc, createDemoBaseline } from '/shared/demo.mjs';
import { createManifest, generateAngelScript } from '/shared/export.mjs';
import { icon } from './icons.mjs';
import { loadWorkspace, saveWorkspace, retainRun } from './store.mjs';

const app = document.querySelector('#app');
const dialog = document.querySelector('#dialog');
const state = {
  catalog: validateCatalog(structuredClone(DEMO_CATALOG)), runs: [], approvals: {}, baselines: {}, mode: 'demo',
  tab: 'overview', selectedId: 'view-matrix', currentRunId: null, filter: 'all', search: '', busy: false,
  progress: 0, progressTotal: 0, error: '', connection: null, buildLabel: 'Build 1.8.3', mobile: false,
  ...loadWorkspace(),
};
let controller;
let toastTimer;
let editId;
let draftRules = [];
let currentSetup = 'direct';
const esc = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll(String.fromCharCode(34), '&quot;').replaceAll("'", '&#39;');
const titleCase = value => value.charAt(0).toUpperCase() + value.slice(1);
const date = value => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const availableRuns = () => state.runs.filter(r => r.mode === state.mode && r.catalogId === state.catalog.id);
const run = () => availableRuns().find(r => r.id === state.currentRunId) ?? availableRuns().at(-1);
const resultFor = id => run()?.results.find(r => r.id === id);
const stale = () => Boolean(run() && run().catalogHash !== hashCatalog(state.catalog));
const approved = () => stale() ? [] : state.approvals[run()?.id] ?? [];
const eligible = item => !stale() && ['valid', 'moved'].includes(resultFor(item.id)?.status) && resultFor(item.id)?.definitionHash === hashItem(item);
const badge = (status, label) => `<span class='status ${STATUS[status]?.tone ?? 'muted'}'>${esc(label ?? STATUS[status]?.label ?? 'Unchecked')}</span>`;
const button = (action, label, glyph, cls = '', extra = '') => `<button type='button' class='button ${cls}' data-action='${action}' ${extra}>${glyph ? icon(glyph, 14) : ''}${label}</button>`;
const empty = (heading, body, glyph = 'scan', action = '') => `<div class='empty'>${icon(glyph, 30)}<h3>${esc(heading)}</h3><p>${esc(body)}</p>${action}</div>`;

function persist() { if(state.storageIssue)return;try { saveWorkspace(state); } catch { toast('Browser storage is full or unavailable. Download your catalog and reports to keep them.', true); } }
function toast(message, error = false) {
  const el = document.querySelector('#toast'); el.textContent = message; el.className = `toast visible${error ? ' error' : ''}`;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), error ? 7000 : 4200);
}
function navigate(tab) { state.tab = tab; state.mobile = false; render(); }
function totals() { const counts = Object.fromEntries(Object.keys(STATUS).map(k => [k, 0])); for (const r of run()?.results ?? []) counts[r.status]++; return counts; }
function navItem(tab, label, glyph, suffix = '') {
  return `<button class='nav-button ${state.tab === tab ? 'active' : ''}' data-action='nav' data-tab='${tab}' ${state.tab === tab ? "aria-current='page'" : ''}>${icon(glyph,18)}<span>${label}</span>${suffix}</button>`;
}
function render() {
  const titles = { overview: 'Overview', catalog: 'Signature catalog', history: 'Build history', exports: 'Export center' };
  const focused = document.activeElement;
  const focusKey = focused?.dataset?.action ? { action: focused.dataset.action, id: focused.dataset.id, tab: focused.dataset.tab, filter: focused.dataset.filter, mode: focused.dataset.mode } : null;
  app.innerHTML = `<div class='app-shell'>
    ${state.mobile ? `<button class='nav-scrim' data-action='mobile' aria-label='Close navigation'></button>` : ''}
    <aside class='sidebar ${state.mobile ? 'open' : ''}' aria-label='Workspace navigation'>
      <a class='brand' href='#overview' aria-label='Signature Doctor home'><span class='brand-mark'>${icon('scan',22)}</span><span class='brand-word'>Signature<span>Doctor<span class='brand-period'>.</span></span></span></a>
      <button class='workspace-box' data-action='project' ${state.busy?'disabled':''} aria-label='Workspace settings'><span class='workspace-icon'>${icon('folder',17)}</span><span class='workspace-copy'><strong title='${esc(state.catalog.name)}'>${esc(state.catalog.name)}</strong><small>${state.mode==='demo'?'Demo workspace':'Local workspace'}</small></span>${icon('chevrondown',13)}</button>
      <button class='command-trigger' data-action='commands'>${icon('search',16)}<span>Jump to…</span><kbd>Ctrl K</kbd></button>
      <div class='nav-section-label'>Workspace</div>
      <nav class='nav'>${navItem('overview','Overview','grid')}${navItem('catalog','Signatures','list',`<span class='nav-count'>${state.catalog.items.length}</span>`)}${navItem('history','Build history','clock')}${navItem('exports','Exports','export',approved().length?`<span class='nav-count'>${approved().length}</span>`:'')}</nav>
      <div class='sidebar-bottom'>
        <div class='runtime-card'><span class='runtime-symbol'>${icon('cpu',20)}</span><strong>Connect your runtime.</strong><p>Bring your own AngelScript host to check a live build.</p><button class='button ghost full' data-action='connect'>Connect runtime${icon('arrow',14)}</button></div>
        <nav class='nav secondary-nav'><a class='nav-button' href='https://github.com/b4rzY/Signature-Doctor#readme' target='_blank' rel='noreferrer'>${icon('book',17)}<span>Documentation</span>${icon('up',13)}</a><button class='nav-button' data-action='project' ${state.busy?'disabled':''}>${icon('settings',17)}<span>Project settings</span></button></nav>
        <div class='sidebar-footer'><span class='environment'><span class='dot'></span>Local workspace</span><span class='version'>v1.1.0</span></div>
      </div>
    </aside>
    <div class='main-wrap' ${state.mobile?'inert':''}><header class='topbar'><div class='breadcrumbs'><button class='icon-button mobile-menu' data-action='mobile' aria-label='Toggle navigation' aria-expanded='${state.mobile}'>${icon('menu')}</button><span class='root-crumb'>${icon('folder',14)}${esc(state.catalog.processName)}</span><span class='crumb-divider'>/</span><strong>${titles[state.tab]}</strong></div><div class='topbar-actions'><span class='local-tag'>${icon('shield',13)} Read-only access</span><button class='connection-pill' data-action='connect'><span class='dot ${state.connection?.agentConnected?'green':''}'></span>${state.connection?.agentConnected?'Runtime connected':'Runtime offline'}</button></div></header>
    <main id='main' class='main'>${pageHead()}${contextBar()}${state.storageIssue ? `<div class='inline-alert error' role='alert'>${icon('warning', 17)}<p>${esc(state.storageIssue.message)} Saving is paused to preserve the original data.</p>${button('recover-storage','Download recovery','export','ghost small',state.storageIssue.raw?'':'disabled')}${button('reset-storage','Replace saved data','reset','ghost small')}</div>` : ''}${state.error ? `<div class='inline-alert error' role='alert'>${icon('warning', 17)}<p>${esc(state.error)}</p><button class='icon-button' data-action='dismiss-error' aria-label='Dismiss error'>${icon('close', 14)}</button></div>` : ''}${stale() ? `<div class='inline-alert'>${icon('info', 17)}<p>The catalog has changed since this check. Run a new check before approving or exporting results.</p></div>` : ''}${state.tab === 'overview' ? overview() : state.tab === 'catalog' ? catalogView() : state.tab === 'history' ? historyView() : exportView()}
      <footer class='footer'><span>${icon('shield', 13)}Your workspace stays on this device.</span><span>Signature Doctor <span class='footer-slash'>/</span> AngelScript workbench</span></footer>
    </main></div></div>`;
  if (focusKey) {
    const next=[...app.querySelectorAll('[data-action]')].find(el=>Object.entries(focusKey).every(([k,v])=>el.dataset[k]===v));
    next?.focus({preventScroll:true});
  }

}
function pageHead() {
  const copy={overview:['Build overview','Know what changed. Keep what works.'],catalog:['Signature catalog','The recipes behind every resolved address.'],history:['Build history','Every check, with its evidence intact.'],exports:['Export reviewed results','From verified addresses to reusable recipes.']}[state.tab];
  return `<section class='page-head'><div><h1>${copy[0]}</h1><p>${copy[1]}</p></div><div class='head-actions'>${button('add','Add signature','plus','ghost',state.busy?'disabled':'')}${state.busy?button('cancel','Cancel check','close','ghost'):button('scan','Check this build','scan','primary',!state.catalog.items.length?'disabled':'')}</div></section>`;
}
function contextBar() {
  return `<section class='context-bar' aria-label='Run environment'><div class='context-left'><div class='mode-switch' aria-label='Data source'><button data-action='mode' data-mode='demo' class='${state.mode==='demo'?'active':''}' aria-pressed='${state.mode==='demo'}' ${state.busy?'disabled':''}>Demo</button><button data-action='mode' data-mode='live' class='${state.mode==='live'?'active':''}' aria-pressed='${state.mode==='live'}' ${state.busy?'disabled':''}>Live</button></div><span class='context-copy'>${state.mode==='demo'?'Simulated process data. Explore freely.':`${esc(state.catalog.processName)} · ${state.connection?.mode==='web-mv'?'web-mv relay':'direct connection'}`}</span></div><label class='build-label'>${icon('branch',15)}<span>Next build</span><input id='build-label' class='build-input' value='${esc(state.buildLabel)}' maxlength='80' aria-label='Label for the next build check' ${state.busy?'disabled':''}>${icon('edit',12)}</label></section>`;
}
function overview() {
  const c=totals(), last=run(), active=last?last.results.filter(r=>r.status!=='disabled').length:state.catalog.items.filter(i=>i.enabled).length;
  const needs=c.moved+c.missing+c.ambiguous+c.invalid+c.error, passing=c.valid+c.moved;
  const baseline=state.runs.find(r=>r.id===last?.baselineId);
  const duration=last?Math.max(0,new Date(last.completedAt)-new Date(last.startedAt)):0;
  const headline=state.busy?'Checking your build…':!last?'Ready for the first check.':needs?`${needs} signatures need a closer look.`:active?'All checks passed.':'No active signatures in this check.';
  return `<section class='build-summary' aria-label='Build summary'><div class='build-story'><div class='build-comparison'><span class='build-version'>${icon('branch',14)}${esc(last?.label??state.buildLabel)}</span><span class='comparison-caption'>${baseline?`compared with <strong>${esc(baseline.label)}</strong>`:'No baseline comparison'}</span></div><h2>${headline}</h2><p>${last?`${c.moved} moved · ${needs-c.moved} unresolved or failed · ${approved().length} reviewed`:'Connect a runtime or explore the demo to resolve your catalog.'}</p><div class='build-story-actions'>${last&&needs?`<button class='text-button' data-action='review-attention'>Review ${needs} results${icon('arrow',15)}</button>`:button('nav','Open catalog','arrow','ghost small',"data-tab='catalog'")}<span class='last-check'>${last?`${icon('clock',13)} ${duration<1000?`${duration} ms`:`${(duration/1000).toFixed(1)} s`} · ${esc(date(last.completedAt))}`:'No completed checks'}</span></div></div><div class='build-health'><div class='health-heading'><span>Resolution coverage</span><span class='health-count'>${passing}<span> / ${active}</span></span></div><div class='signature-map' aria-label='Results by signature'>${state.catalog.items.map(item=>{const r=resultFor(item.id);return `<button class='map-cell ${STATUS[r?.status]?.tone??'muted'} ${state.selectedId===item.id?'selected':''}' data-action='select' data-id='${esc(item.id)}' aria-label='Inspect ${esc(item.name)}: ${esc(STATUS[r?.status]?.label??'Unchecked')}' title='${esc(item.name)} · ${esc(STATUS[r?.status]?.label??'Unchecked')}'>${icon(r?.status==='valid'?'check':r?.status==='disabled'?'close':r?.status==='moved'?'arrow':'warning',14)}</button>`;}).join('')}</div><div class='health-legend'><span><i class='dot green'></i>${c.valid} valid</span><span><i class='dot amber'></i>${c.moved} moved</span><span><i class='dot red'></i>${c.missing+c.ambiguous+c.invalid+c.error} unresolved</span></div></div></section>
  <div class='workspace-grid'><div class='results-column'>${catalogPanel()}<div class='below-table'>${icon('branch',16)}<span>${baseline?`Baseline: ${esc(baseline.label)}`:'Select a completed build as your baseline.'}</span><button class='text-button' data-action='nav' data-tab='history'>Build history${icon('arrow',14)}</button></div><section class='recent-builds'><div class='section-heading'><h2>Recent checks</h2><button class='text-button' data-action='nav' data-tab='history'>View history${icon('arrow',14)}</button></div>${availableRuns().slice(-2).reverse().map(r=>`<button class='recent-run' data-action='view-run' data-id='${esc(r.id)}'><span class='run-symbol'>${icon('branch',17)}</span><span class='recent-run-name'>${esc(r.label)}<small>${esc(date(r.completedAt))}</small></span><span class='recent-run-meta'>${r.results.filter(x=>['valid','moved'].includes(x.status)).length}/${r.results.filter(x=>x.status!=='disabled').length} passed</span>${icon('chevron',15)}</button>`).join('')||`<p class='muted'>Your completed checks will appear here.</p>`}</section></div><div class='inspector-column'>${inspector()}</div></div>`;
}
function catalogPanel() {
  const current = run();
  const items = state.catalog.items.filter(i => `${i.name} ${i.module} ${i.pattern ?? i.rva ?? ''}`.toLowerCase().includes(state.search.toLowerCase()) && (state.filter === 'all' || state.filter === 'approved' ? state.filter !== 'approved' || approved().includes(i.id) : ['moved','missing','ambiguous','invalid','error'].includes(resultFor(i.id)?.status)));
  return `<section class='panel catalog-panel'><div class='panel-head'><div><div class='panel-title'><h2>Signature catalog</h2><span class='count-tag'>${state.catalog.items.length}</span></div><p class='panel-subtitle'>${current ? `${esc(current.label)} · ${esc(date(current.completedAt))}` : 'No results yet. Run a build check.'}</p></div><button class='icon-button' data-action='catalog-export' title='Download catalog' aria-label='Download catalog JSON'>${icon('export', 16)}</button></div><div class='toolbar'><div class='filter-tabs' aria-label='Filter signatures'>${[['all','All signatures'],['attention','Needs attention'],['approved','Approved']].map(([key,label])=>`<button class='filter-tab ${state.filter===key?'active':''}' data-action='filter' data-filter='${key}' aria-pressed='${state.filter===key}'>${label}</button>`).join('')}</div><label class='search-box'>${icon('search',13)}<input id='catalog-search' placeholder='Find a signature…' aria-label='Search signatures' value='${esc(state.search)}'></label></div>${state.busy ? `<div class='progress-strip' role='progressbar' aria-valuemin='0' aria-valuemax='${state.progressTotal}' aria-valuenow='${state.progress}' aria-label='Checking signatures'><div style='width:${state.progressTotal ? state.progress/state.progressTotal*100 : 0}%'></div></div>` : ''}
    <div class='table-wrap'>${items.length ? `<table><thead><tr><th scope='col'>Signature</th><th scope='col' class='module-col'>Module</th><th scope='col' class='resolution-col'>Resolution</th><th scope='col'>Status</th><th scope='col'>Change</th></tr></thead><tbody>${items.map(item=>catalogRow(item)).join('')}</tbody></table>` : empty(state.search || state.filter!=='all' ? 'No matching signatures' : 'Your catalog starts here', state.search || state.filter!=='all' ? 'Try another search or choose All signatures.' : 'Add a resolution recipe, or import an existing catalog.', 'search')}</div>
    <div class='panel-foot'><span>${items.length} of ${state.catalog.items.length} signatures</span><span>${icon('shield',11)}${state.mode === 'demo' ? 'Simulated reads' : 'Read-only checks'}${state.busy?' · checking…':''}</span></div></section>`;
}
function catalogRow(item) {
  const r = resultFor(item.id); const symbol = item.kind === 'pointer' ? 'link' : item.kind === 'rva' ? 'target' : 'scan';
  let delta = '—';
  if (r?.status === 'moved') { try { const destinationChanged=r.rva&&r.previousRva&&r.rva!==r.previousRva;const d = destinationChanged ? parseAddress(r.rva)-parseAddress(r.previousRva) : parseAddress(r.sourceRva)-parseAddress(r.previousSourceRva); delta = d===0n?'relocated':`${d >= 0 ? '+' : ''}${hex(d)}`; } catch { delta='changed'; } }
  else if (r?.comparison === 'dynamic') delta = 'dynamic'; else if (r?.comparison === 'unchanged') delta = 'stable'; else if (r?.comparison === 'definition_changed') delta = 'edited'; else if(r?.status === 'ambiguous') delta=`${r.candidateCount ?? r.candidates?.length ?? '?'} hits`;
  return `<tr class='catalog-row ${state.selectedId === item.id ? 'selected' : ''}' data-action='select' data-id='${esc(item.id)}' ><td><div class='item-name'><span class='item-symbol'>${icon(symbol,13)}</span><div><strong><button class='signature-select' data-action='select' data-id='${esc(item.id)}' aria-pressed='${state.selectedId===item.id}'>${esc(item.name)}</button>${approved().includes(item.id)?`<span class='approved-icon' title='Approved'>${icon('circlecheck',11)}</span>`:''}</strong><small>${item.kind === 'signature' ? item.relative ? 'Signature · rel32' : 'Signature pattern' : item.kind === 'pointer' ? `${item.offsets.length}-hop pointer chain` : 'Module-relative offset'}</small></div></div></td><td class='module-col mono'>${esc(item.module)}</td><td class='resolution-col resolution-cell' title='${esc(r?.address ?? item.pattern ?? item.rva)}'>${esc(r?.rva ? `+${r.rva}` : item.pattern ? item.pattern.slice(0,20) : item.rva)}</td><td>${badge(r?.status ?? (item.enabled?'unchecked':'disabled'))}</td><td class='delta ${r?.status === 'moved' ? 'changed' : ''}'>${esc(delta)}</td></tr>`;
}
function inspector() {
  const item = state.catalog.items.find(i=>i.id === state.selectedId) ?? state.catalog.items[0];
  if (!item) return `<aside class='panel inspector'>${empty('Inspect a signature', 'Select an item to see its resolution path and validation evidence.', 'target')}</aside>`;
  const r = resultFor(item.id); const isApproved = approved().includes(item.id);
  const trace = r?.trace ?? [{label:'Expected module',value:item.module},{label:'Resolution recipe',value:item.kind === 'signature'?item.pattern:`Module + ${item.rva}`}];
  return `<aside class='panel inspector' aria-label='Selected signature details' tabindex='-1'><div class='panel-head'><div class='panel-title'>${icon('target',15)}<h2>Signature inspector</h2></div><button class='icon-button' data-action='edit' data-id='${esc(item.id)}' aria-label='Edit ${esc(item.name)}' ${state.busy?'disabled':''}>${icon('edit',14)}</button></div><div class='inspector-body'><button class='text-button back-to-results' data-action='back-to-results'>${icon('arrowup',14)}Back to results</button><div class='inspector-title'><span class='inspector-symbol'>${icon(item.kind==='pointer'?'link':'scan',23)}</span>${badge(r?.status??'unchecked')}</div><h3>${esc(item.name)}</h3><span class='inspector-module'>${icon('cpu',12)}${esc(item.module)}</span><p class='description'>${esc(r?.message ?? item.notes ?? 'Run a check to inspect this recipe.')}</p><div class='detail-rule'></div><div class='detail-label'>${item.kind === 'signature' ? 'Byte pattern' : 'Root offset'}</div><div class='pattern byte-pattern'>${esc(item.pattern ?? `${item.module}+${item.rva}`).replaceAll('??',`<span class='wild'>??</span>`)}</div><div class='detail-rule'></div><div class='detail-label'>Resolution path</div><div class='trace'>${trace.map(t=>`<div class='trace-step'><span class='step-label'>${esc(t.label)}</span><code>${esc(t.value)}</code></div>`).join('')}</div>${r?.candidates?.length ? `<div class='detail-rule'></div><div class='detail-label'>Candidate addresses</div><div class='pattern'>${r.candidates.map(esc).join('<br>')}</div>` : ''}${r?.checks?.length ? `<div class='detail-rule'></div><div class='detail-label'>Validation evidence</div><div class='check-list'>${r.checks.map(c=>`<div class='check-row ${c.passed?'':'failed'}'>${icon(c.passed?'circlecheck':'warning',12)}<div>${esc(c.label)}<small>${esc(c.detail)}</small></div></div>`).join('')}</div>` : ''}${addressComparison(r)}<div class='detail-rule'></div>${button('approve',isApproved?'Approved · undo review':'Approve this result',isApproved?'circlecheck':'check',isApproved?'full ghost':'full primary',`data-id='${esc(item.id)}' ${!eligible(item)||state.busy?'disabled':''}`)}<p class='review-note'>${eligible(item)?'Approval applies to this check and definition only.':'Only passing results can be approved for export.'}</p><div class='inspector-footer'>${button('edit','Edit recipe','edit','ghost small',`data-id='${esc(item.id)}' ${state.busy?'disabled':''}`)}${button('copy-address','Copy address','copy','ghost small',`data-id='${esc(item.id)}' ${!r?.address?'disabled':''}`)}</div></div></aside>`;
}
function addressComparison(result) {
  if (!result?.rva) return '';
  return `<div class='detail-rule'></div><div class='detail-label'>Module-relative address</div><div class='address-comparison'>${result.previousRva?`<span><small>Baseline</small><code>${esc(result.previousRva)}</code></span>${icon('arrow',15)}`:''}<span><small>Current build</small><code class='current-address'>${esc(result.rva)}</code></span></div>`;
}
function catalogView() {
  return `<section class='panel project-settings'><div><h3>${esc(state.catalog.name)}</h3><p>Expected process: <code>${esc(state.catalog.processName)}</code> · schema v1</p></div><div class='catalog-actions'>${button('new-project','New catalog','plus','ghost small',state.busy?'disabled':'')}${button('project','Settings','edit','ghost small',state.busy?'disabled':'')}${button('import','Import','upload','ghost small',state.busy?'disabled':'')}${button('catalog-export','Export','export','ghost small')}</div></section><div class='workspace-grid'><div>${catalogPanel()}</div><div>${inspector()}</div></div>`;
}
function historyView() {
  const list = availableRuns().slice().reverse();
  return `<section><div class='panel-head' style='padding:0 0 18px'><div class='panel-title'><h2>Completed checks</h2><span class='count-tag'>${list.length}</span></div><span class='muted' style='font-size:10px'>Last 20 checks retained across environments</span></div>${list.length ? `<div class='history-grid'>${list.map(r=>{const c=Object.fromEntries(Object.keys(STATUS).map(k=>[k,r.results.filter(x=>x.status===k).length]));return `<article class='history-card ${run()?.id===r.id?'current':''}'><div><h3>${esc(r.label)}${r.id === state.baselines[state.mode]?badge('valid','Baseline'):''}${badge('disabled',r.mode==='demo'?'Demo':'Live')}</h3><p>${esc(date(r.completedAt))} · ${r.results.length} signatures · PID ${r.target.pid} · ${esc(r.target.modules.find(m=>m.base===r.target.base)?.name ?? state.catalog.processName)}</p><div class='history-statuses'>${Object.entries(c).filter(([,v])=>v).map(([k,v])=>badge(k,`${v} ${STATUS[k].label.toLowerCase()}`)).join('')}</div></div><div class='history-actions'>${button('view-run','Inspect','arrow','small',`data-id='${esc(r.id)}'`)}${button('baseline',r.id===state.baselines[state.mode]?'Current baseline':'Set as baseline','branch','ghost small',`data-id='${esc(r.id)}' ${state.busy||r.id===state.baselines[state.mode]?'disabled':''}`)}${button('report','JSON','export','ghost small',`data-id='${esc(r.id)}'`)}</div></article>`;}).join('')}</div>`:empty('No checks in this environment yet','Run Check this build to create your first result. A later check can be compared with this baseline.','clock')}</section>`;
}
function exportView() {
  const n = approved().length; const c = totals();
  return `<div class='export-overview'><div><strong>${n} reviewed ${n===1?'result':'results'} ready to export</strong><p>${run()?esc(run().label):'Run a check first'} · ${state.mode==='demo'?'Demo artifacts are labeled as simulated.':'Only explicitly approved, passing results are included.'}</p></div><span class='status ${n?'green':'muted'}'>${n} / ${c.valid+c.moved} passing results approved</span></div><div class='export-grid'><article class='export-card'>${icon('file',27)}<h3>Resolution manifest</h3><p>A versioned JSON file with reviewed resolution recipes, validation rules, and observed build evidence.</p>${button('manifest','Download manifest','export','primary',n?'':'disabled')}</article><article class='export-card'>${icon('code',27)}<h3>AngelScript resolvers</h3><p>Readable .as functions that resolve addresses at runtime and repeat validation. ${state.mode==='demo'?'Available after a live check and review.':'Uses the shared process API supported by compatible AngelScript runtimes.'}</p>${button('angelscript','Download .as','export','',n&&state.mode==='live'?'':'disabled')}</article><article class='export-card'>${icon('pulse',27)}<h3>Full diagnostic report</h3><p>Every result, including unresolved items, candidate matches, and validation evidence. Useful for investigating an update.</p>${button('report','Download report','export','',run()?'':'disabled')}</article></div><div class='below-table' style='margin-top:20px'>${icon('shield',16)}<span>Review results in the inspector. Saved addresses are observations; exported resolvers find them again at runtime.</span>${button('nav','Review signatures','arrow','ghost small',"data-tab='overview'")}</div>`;
}

async function liveRpc(request, signal) {
  const response = await fetch('/api/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request), signal });
  const data = await response.json();
  if (!response.ok && data.type !== 'error') throw new Error(data.message || `Bridge returned HTTP ${response.status}`);
  return data;
}
async function refreshConnection() {
  try {
    const response = await fetch('/api/status', { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('Bridge unavailable');
    state.connection = await response.json();
  } catch { state.connection = null; }
  const pill = document.querySelector('.connection-pill');
  if (pill) pill.innerHTML = `<span class='dot ${state.connection?.agentConnected ? 'green' : ''}'></span>${state.connection?.agentConnected ? 'Runtime connected' : 'Runtime offline'}`;
}
async function startScan() {
  if (state.busy) return;
  state.error = ''; state.busy = true; state.progress = 0; state.progressTotal = state.catalog.items.length;
  controller = new AbortController(); render();
  try {
    if (state.mode === 'live') { await refreshConnection(); if (!state.connection?.agentConnected) throw new Error('The runtime is offline. Open Connect runtime for the direct connector or the existing web-mv relay setup.'); }
    const baseline = state.runs.find(r=>r.id === state.baselines[state.mode]);
    const completed = await checkBuild(state.catalog, {
      rpc: state.mode === 'demo' ? createDemoRpc('updated') : liveRpc,
      baseline, mode: state.mode, label: state.buildLabel.trim() || 'Untitled build', signal: controller.signal,
      onProgress({completed,total}) { state.progress = completed; state.progressTotal = total; const el = document.querySelector('.progress-strip'); if(el){el.setAttribute('aria-valuenow',String(completed));el.querySelector('div').style.width=`${completed/Math.max(1,total)*100}%`;} },
    });
    retainRun(state, completed); state.currentRunId = completed.id; state.approvals[completed.id] = [];
    state.selectedId = completed.results.find(r=>r.status==='moved')?.id ?? state.selectedId;
    persist(); toast('Build check complete. Inspect the evidence before approving results.');
  } catch(error) {
    if(controller.signal.aborted) toast('Check cancelled. The previous completed results were kept.');
    else { state.error=error.message; toast(error.message, true); }
  } finally { state.busy=false; controller=null; render(); animateScanResult(); }
}
function download(filename, content, mime='application/json') {
  const url = URL.createObjectURL(new Blob([typeof content === 'string'?content:JSON.stringify(content,null,2)+'\n'],{type:mime}));
  const a=document.createElement('a'); a.href=url; a.download=filename; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),2000);
}
const safeFilename = value => String(value).replace(/[^a-z0-9._-]+/gi,'-').slice(0,64)||'signature-doctor';
async function copy(value) {
  try { await navigator.clipboard.writeText(value); toast('Copied to clipboard.'); }
  catch { toast('Clipboard access is unavailable in this browser. You can copy the displayed value manually.',true); }
}
function showDialog(title, description, body, actions='', formId='') {
  dialog.classList.remove('command-dialog');
  dialog.innerHTML=`<div class='dialog-header'><div><h2 id='dialog-title'>${esc(title)}</h2><p>${esc(description)}</p></div><button class='icon-button' data-action='close-dialog' aria-label='Close dialog'>${icon('close',17)}</button></div>${formId?`<form id='${formId}'>`:''}<div class='dialog-body'>${body}</div>${actions?`<div class='dialog-actions'>${actions}</div>`:''}${formId?'</form>':''}`;
  if(!dialog.open)dialog.showModal();
}
function field(label,name,value='',help='',extra='') { return `<label class='field ${extra.includes('data-wide')?'wide':''}'><span>${label}</span><input name='${name}' value='${esc(value)}' ${extra}>${help?`<small>${help}</small>`:''}</label>`; }
function ruleControls(rule) {
  switch(rule.type) {
    case 'readable': return `<input name='size' type='number' min='1' max='65536' value='${rule.size??8}' aria-label='Bytes to read' title='Bytes to read'>`;
    case 'bytes': return `<input name='pattern' class='mono' value='${esc(rule.pattern??'48 8B ??')}' placeholder='48 8B ??' aria-label='Expected byte pattern'>`;
    case 'range': return `<select name='dataType' aria-label='Numeric data type'>${['u8','i8','u16','i16','u32','i32','u64','i64','f32','f64'].map(t=>`<option value='${t}' ${t===(rule.dataType??'u32')?'selected':''}>${t}</option>`).join('')}</select><input name='min' value='${esc(rule.min??'0')}' placeholder='Minimum' aria-label='Minimum value'><input name='max' value='${esc(rule.max??'1000')}' placeholder='Maximum' aria-label='Maximum value'>`;
    case 'in_module': return `<input name='module' value='${esc(rule.module??state.catalog.processName)}' placeholder='engine.dll' aria-label='Expected destination module'>`;
    case 'alignment': return `<input name='value' type='number' min='1' max='65536' value='${rule.value??8}' aria-label='Byte alignment (power of two)' title='Power of two'>`;
  }
}
function renderRules() {
  const el=dialog.querySelector('#validation-rules'); if(!el)return;
  el.innerHTML=draftRules.map((rule,i)=>`<div class='validation-rule' data-rule='${i}'><select name='ruleType' data-action='rule-type' aria-label='Validation type'>${[['readable','Readable bytes'],['bytes','Expected pattern'],['range','Numeric range'],['in_module','Inside module'],['alignment','Alignment']].map(([v,l])=>`<option value='${v}' ${rule.type===v?'selected':''}>${l}</option>`).join('')}</select><div class='rule-controls'>${ruleControls(rule)}</div><button type='button' class='icon-button' data-action='remove-rule' data-index='${i}' aria-label='Remove validation rule'>${icon('close',13)}</button></div>`).join('');
}
function readRules() {
  return [...dialog.querySelectorAll('[data-rule]')].map(row=>{
    const val=name=>row.querySelector(`[name='${name}']`)?.value;
    const type=val('ruleType');
    if(type==='readable')return{type,size:Number(val('size'))};
    if(type==='bytes')return{type,pattern:val('pattern')};
    if(type==='range')return{type,dataType:val('dataType'),min:val('min'),max:val('max')};
    if(type==='in_module')return{type,module:val('module')};
    return{type,value:Number(val('value'))};
  });
}
function showEditor(id) {
  if(state.busy)return;
  const item=state.catalog.items.find(i=>i.id===id);editId=item?.id;
  draftRules=structuredClone(item?.checks??[{type:'readable',size:8}]);
  showDialog(item?'Edit resolution recipe':'Add a signature','A good recipe specifies where to look and how to validate the result.',`
    <div id='form-error' class='form-error' role='alert'></div><div class='form-grid'>
    ${field('Name','name',item?.name??'','A unique, recognizable name.',"required maxlength='96' autofocus")}
    ${field('Expected module','module',item?.module??state.catalog.processName,'Exact loaded module filename.',"required maxlength='128' class='mono'")}
    <label class='field wide'><span>Resolution method</span><select name='kind' id='item-kind'>${[['signature','Signature pattern'],['rva','Module + RVA'],['pointer','Pointer chain']].map(([v,l])=>`<option value='${v}' ${(item?.kind??'signature')===v?'selected':''}>${l}</option>`).join('')}</select></label>
    <label class='field wide' data-kind-group='signature'><span>IDA byte pattern</span><input name='pattern' class='mono' value='${esc(item?.pattern??'')}' placeholder='48 8B 05 ?? ?? ?? ??' maxlength='1024'><small>Use complete byte pairs. ? and ?? are wildcards. Every match is counted.</small></label>
    <label class='field wide' data-kind-group='rva,pointer'><span>Root RVA</span><input name='rva' class='mono' value='${esc(item?.rva??'0x0')}' placeholder='0x1234'><small>Offset from the module base. Do not enter an absolute address.</small></label>
    <div class='field wide' data-kind-group='signature'><label class='check-label'><input name='useRelative' id='use-relative' type='checkbox' ${item?.relative?'checked':''}>Resolve a signed 32-bit relative reference</label></div>
    <div class='field' data-relative>${field('Displacement byte offset','relativeOffset',item?.relative?.offset??3,'Offset within the matched instruction.',"type='number' min='0' max='60'")}</div>
    <div class='field' data-relative>${field('Instruction size','instructionSize',item?.relative?.instructionSize??7,'Measured from the match address.',"type='number' min='1' max='64'")}</div>
    <label class='field wide' data-kind-group='pointer'><span>Pointer offsets</span><input name='offsets' class='mono' value='${esc(item?.offsets?.join(', ')??'0x0, 0x20')}' placeholder='0x0, 0x20'><small>One dereference per offset: address = *address + offset. Maximum 12 hops.</small></label>
    <label class='field' data-kind-group='pointer'><span>Pointer width</span><select name='pointerSize'><option value='8' ${item?.pointerSize!==4?'selected':''}>64-bit (8 bytes)</option><option value='4' ${item?.pointerSize===4?'selected':''}>32-bit (4 bytes)</option></select></label>
    ${field('Final addend','addend',item?.addend??'0x0','Added after resolution. Signed offsets are supported.',"class='mono'")}
    </div><div class='form-section'>Validation rules<button type='button' class='text-button' data-action='add-rule'>${icon('plus',12)}Add rule</button></div><div id='validation-rules' class='validation-list'></div><p class='muted' style='font-size:10px;margin-top:10px'>Every result is checked for readability. Add semantic checks to make the result more meaningful.</p><div class='form-grid' style='margin-top:18px'><label class='field wide'><span>Notes</span><textarea name='notes' maxlength='4000' placeholder='What does this address represent?'>${esc(item?.notes??'')}</textarea></label><label class='field wide'><span class='check-label'><input type='checkbox' name='enabled' ${item?.enabled!==false?'checked':''}>Include in build checks</span></label></div>`,
    `<div>${item?button('delete-item','Delete recipe','trash','ghost danger',`data-id='${esc(item.id)}'`):'<span></span>'}</div><div>${button('close-dialog','Cancel',null,'ghost')}<button type='submit' class='button primary'>${icon('check',14)}Save recipe</button></div>`,'item-form');
  renderRules();updateEditorVisibility();
}
function updateEditorVisibility() {
  const kind=dialog.querySelector('#item-kind')?.value;if(!kind)return;
  for(const el of dialog.querySelectorAll('[data-kind-group]')) {el.hidden=!el.dataset.kindGroup.split(',').includes(kind);for(const control of el.querySelectorAll('input,select,textarea'))control.disabled=el.hidden;}
  for(const el of dialog.querySelectorAll('[data-relative]')) {el.hidden=kind!=='signature'||!dialog.querySelector('#use-relative').checked;for(const control of el.querySelectorAll('input,select,textarea'))control.disabled=el.hidden;}
}
function saveItem(form) {
  const f=new FormData(form);const kind=f.get('kind');
  const item={id:editId??`item-${globalThis.crypto?.randomUUID?.()??Date.now().toString(36)}`,name:f.get('name'),module:f.get('module'),kind,addend:f.get('addend'),checks:readRules(),notes:f.get('notes'),enabled:f.get('enabled')==='on'};
  if(kind==='signature'){item.pattern=f.get('pattern');if(f.get('useRelative')==='on')item.relative={offset:Number(f.get('relativeOffset')),instructionSize:Number(f.get('instructionSize'))};}
  else item.rva=f.get('rva');
  if(kind==='pointer'){item.offsets=String(f.get('offsets')).split(',').map(x=>x.trim()).filter(Boolean);item.pointerSize=Number(f.get('pointerSize'));}
  const items=editId?state.catalog.items.map(x=>x.id===editId?item:x):[...state.catalog.items,item];
  try{state.catalog=validateCatalog({...state.catalog,items});state.selectedId=item.id;state.approvals={};persist();dialog.close();render();toast('Recipe saved. Run a new check to validate it.');}catch(error){dialog.querySelector('#form-error').textContent=error.message;}
}
function showProject(isNew=false) {
  showDialog(isNew?'Create a new catalog':'Project settings','The expected process protects against checking the wrong application.',`<div id='form-error' class='form-error' role='alert'></div>${isNew?`<p class='muted' style='font-size:11px;margin-bottom:18px'>This starts an empty live catalog and replaces the active workspace and history. ${button('catalog-export','Download current catalog','export','ghost small')}</p>`:''}<div class='form-grid'>${field('Workspace name','name',isNew?'':state.catalog.name,'',"required maxlength='96'")}${field('Expected process','processName',isNew?'YourApp.exe':state.catalog.processName,'Main executable filename, including .exe.',"required maxlength='128' class='mono'")}</div>`, `<span class='muted' style='font-size:10px'>${isNew?'Your target is never attached automatically.':'Changing this requires a new check.'}</span><div>${button('close-dialog','Cancel',null,'ghost')}<button type='submit' class='button primary'>${isNew?'Create catalog':'Save settings'}</button></div>`,isNew?'new-project-form':'project-form');
}
function codeBox(text) {return `<div class='code-box mono'>${esc(text)}<button class='icon-button' data-action='copy-code' data-copy='${esc(text)}' aria-label='Copy code'>${icon('copy',14)}</button></div>`;}
function showSetup(mode=currentSetup) {
  currentSetup=mode;
  const direct=`<div class='setup-step'><span class='step-number'>1</span><div><h3>Start Signature Doctor locally</h3><p>Run the server on the same computer as your AngelScript runtime.</p>${codeBox('npm ci\nnpm start')}</div></div><div class='setup-step'><span class='step-number'>2</span><div><h3>Set your target in the connector</h3><p>Open <code>examples/angelscript-connect.as</code>, set <code>PROCESS_NAME</code>, then load it in your script loader.</p><a class='button ghost small connector-download' href='/api/connector' download='angelscript-connect.as'>Download connector</a>${codeBox('const string PROCESS_NAME = "YourApp.exe";\nconst string RELAY_URL = "ws://127.0.0.1:3210/agent";')}</div></div><div class='setup-step'><span class='step-number'>3</span><div><h3>Import your catalog and choose Live</h3><p>Set the expected process in Catalog → Project settings. The target must be attached before you check a build.</p></div></div><div class='quick-info'>The connector uses the shared process, JSON, and WebSocket APIs. Keep one connector active; if you already use web-mv, select its existing relay instead.</div>`;
  const proxy=`<div class='setup-step'><span class='step-number'>1</span><div><h3>Keep your existing web-mv agent connected</h3><p>Signature Doctor can share its relay. Your current agent remains the connection to the target.</p></div></div><div class='setup-step'><span class='step-number'>2</span><div><h3>Start Doctor with the relay URL</h3><p>PowerShell:</p>${codeBox('$env:WEB_MV_URL="http://127.0.0.1:9000/rpc"\nnpm start')}<p style='margin-top:10px'>macOS / Linux shell:</p>${codeBox('WEB_MV_URL=http://127.0.0.1:9000/rpc npm start')}</div></div><div class='setup-step'><span class='step-number'>3</span><div><h3>Switch to Live and check your build</h3><p>Only read operations are sent to the relay. Its own request timeout still applies.</p></div></div>`;
  showDialog('Connect your environment','Live connections run locally on your computer.',`<div class='setup-tabs'>${button('setup-direct','Direct AngelScript','link',mode==='direct'?'primary':'ghost')}${button('setup-proxy','Existing web-mv','branch',mode==='web-mv'?'primary':'ghost')}</div>${mode==='direct'?direct:proxy}`,`<div class='environment'><span class='dot ${state.connection?.agentConnected?'green':''}'></span>${state.connection?.agentConnected?'Agent connected':'No agent connected'} · ${esc(state.connection?.mode??'bridge unavailable')}</div><div>${button('refresh-connection','Refresh status','reset','ghost')}${button('close-dialog','Done','check','primary')}</div>`);
}
function importCatalog() {
  const input=document.createElement('input');input.type='file';input.accept='.json,application/json';input.style.display='none';document.body.append(input);
  input.addEventListener('change',async()=>{
    const file=input.files?.[0];input.remove();if(!file)return;
    try{
      if(file.size>1_000_000)throw new Error('Catalog file exceeds the 1 MB limit.');
      const catalog=validateCatalog(JSON.parse(await file.text()));
      showDialog('Import catalog',`${catalog.items.length} recipes from ${file.name}`,`<p style='font-size:12px;color:var(--muted);line-height:1.8'>This replaces the active catalog with <strong>${esc(catalog.name)}</strong>, expected process <code>${esc(catalog.processName)}</code>. Current history and approvals will be cleared. Download your current catalog first if you want to keep it.</p>`, `<div>${button('catalog-export','Save current catalog','export','ghost small')}</div><div>${button('close-dialog','Cancel',null,'ghost')}${button('confirm-import','Import catalog','upload','primary')}</div>`);
      dialog.querySelector('[data-action=confirm-import]').addEventListener('click',()=>{state.catalog=catalog;state.runs=[];state.approvals={};state.baselines={};state.currentRunId=null;state.selectedId=catalog.items[0]?.id;state.filter='all';state.search='';persist();dialog.close();render();toast('Catalog imported. Choose Live when your target is connected.');},{once:true});
    }catch(error){toast(`Import failed: ${error.message}`,true);}
  },{once:true});
  input.addEventListener('cancel',()=>input.remove(),{once:true});input.click();
}

document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');if(!el||el.disabled)return;
  const action=el.dataset.action;
  try{
    switch(action){
      case 'command-select':dialog.close();state.mobile=false;state.selectedId=el.dataset.id;state.tab='overview';state.filter='all';state.search='';render();revealInspector();break;
      case 'nav':if(dialog.classList.contains('command-dialog'))dialog.close();navigate(el.dataset.tab);break;
      case 'mobile':state.mobile=!state.mobile;render();(state.mobile?document.querySelector('.sidebar .brand'):document.querySelector('.mobile-menu'))?.focus();break;
      case 'commands':showCommands();break;
      case 'review-attention':state.filter='attention';render();document.querySelector('.catalog-panel')?.scrollIntoView({behavior:window.matchMedia?.('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});break;
      case 'focus-search':state.tab='catalog';state.filter='all';render();document.querySelector('#catalog-search')?.focus();break;
      case 'mode':if(!state.busy){state.mode=el.dataset.mode;state.currentRunId=null;state.error='';state.filter='all';persist();render();}break;
      case 'filter':state.filter=el.dataset.filter;render();break;
      case 'select':state.selectedId=el.dataset.id;render();revealInspector();break;
      case 'back-to-results':{const selected=[...document.querySelectorAll('.signature-select')].find(node=>node.dataset.id===state.selectedId);(selected??document.querySelector('#catalog-search'))?.focus();document.querySelector('.catalog-panel')?.scrollIntoView({block:'start'});break;}
      case 'scan':await startScan();break;
      case 'cancel':controller?.abort();break;
      case 'dismiss-error':state.error='';render();break;
      case 'recover-storage':if(state.storageIssue?.raw)download('signature-doctor.recovery.json',state.storageIssue.raw);break;
      case 'reset-storage':showDialog('Replace the saved workspace?','Download the recovery file first if you need the previous data.',`<p class='muted'>This replaces the unreadable saved data with the workspace currently shown. It cannot be undone.</p>`,`<span></span><div>${button('close-dialog','Cancel',null,'ghost')}${button('confirm-reset-storage','Replace saved data','reset','primary')}</div>`);break;
      case 'confirm-reset-storage':state.storageIssue=null;persist();dialog.close();render();toast('The current workspace has replaced the saved data.');break;
      case 'add':showEditor();break;
      case 'edit':showEditor(el.dataset.id);break;
      case 'project':showProject();break;
      case 'new-project':showProject(true);break;
      case 'close-dialog':dialog.close();break;
      case 'add-rule':draftRules=readRules();if(draftRules.length>=16)throw new Error('A recipe supports at most 16 validation rules.');draftRules.push({type:'readable',size:8});renderRules();break;
      case 'remove-rule':draftRules=readRules();draftRules.splice(Number(el.dataset.index),1);renderRules();break;
      case 'delete-item':{
        const id=el.dataset.id;const item=state.catalog.items.find(i=>i.id===id);showDialog('Delete recipe?',`Remove ${item.name} from this catalog.`,`<p class='muted' style='font-size:12px'>Previous reports stay in history. Current approvals will be cleared because the catalog changes.</p>`,`<span></span><div>${button('close-dialog','Cancel',null,'ghost')}${button('confirm-delete','Delete recipe','trash','danger',`data-id='${esc(id)}'`)}</div>`);break;
      }
      case 'confirm-delete':state.catalog=validateCatalog({...state.catalog,items:state.catalog.items.filter(i=>i.id!==el.dataset.id)});state.approvals={};state.selectedId=state.catalog.items[0]?.id;persist();dialog.close();render();toast('Recipe deleted.');break;
      case 'approve':{
        const item=state.catalog.items.find(i=>i.id===el.dataset.id);if(!item||!eligible(item)||state.busy)break;
        const ids=new Set(approved());const undo=ids.has(item.id);undo?ids.delete(item.id):ids.add(item.id);state.approvals[run().id]=[...ids];persist();render();toast(undo?'Approval removed.':`${item.name} approved for this build check.`);break;
      }
      case 'baseline':if(!state.busy){state.baselines[state.mode]=el.dataset.id;persist();render();toast('Baseline selected. The next check will compare against it.');}break;
      case 'view-run':state.currentRunId=el.dataset.id;state.tab='overview';render();break;
      case 'copy-address':await copy(resultFor(el.dataset.id)?.address??'');break;
      case 'catalog-export':download(`${safeFilename(state.catalog.name)}.catalog.json`,state.catalog);toast('Catalog downloaded.');break;
      case 'manifest':download(`${safeFilename(run().label)}.manifest.json`,createManifest(state.catalog,run(),approved()));toast('Reviewed manifest downloaded.');break;
      case 'angelscript':download(`${safeFilename(run().label)}.resolvers.as`,generateAngelScript(state.catalog,run(),approved()),'text/plain');toast('AngelScript resolvers downloaded.');break;
      case 'report':{const report=state.runs.find(r=>r.id===el.dataset.id)??run();if(!report)throw new Error('Run a build check first.');download(`${safeFilename(report.label)}.report.json`,report);toast('Diagnostic report downloaded.');break;}
      case 'import':importCatalog();break;
      case 'connect':showSetup(state.connection?.mode??'direct');break;
      case 'setup-direct':showSetup('direct');break;
      case 'setup-proxy':showSetup('web-mv');break;
      case 'refresh-connection':await refreshConnection();showSetup();break;
      case 'copy-code':await copy(el.dataset.copy??'');break;
    }
  }catch(error){toast(error.message,true);}
});
document.addEventListener('input',event=>{
  if(event.target.id==='command-search'){const q=event.target.value.toLowerCase().trim();const rows=[...dialog.querySelectorAll('.command-option')];for(const row of rows)row.hidden=!row.dataset.commandLabel.includes(q);dialog.querySelector('.command-empty').hidden=rows.some(row=>!row.hidden);}
  if(event.target.id==='catalog-search'){
    const input=event.target;const pos=input.selectionStart;state.search=input.value;render();const next=document.querySelector('#catalog-search');next?.focus();next?.setSelectionRange(pos,pos);
  }
  if(event.target.id==='build-label')state.buildLabel=event.target.value;
});
document.addEventListener('change',event=>{
  if(['item-kind','use-relative'].includes(event.target.id))updateEditorVisibility();
  if(event.target.name==='ruleType'){
    const i=Number(event.target.closest('[data-rule]').dataset.rule);const newType=event.target.value;
    const saved=readRules();saved[i]={type:newType};draftRules=saved;renderRules();
  }
});
document.addEventListener('submit',event=>{
  if(event.target.id==='item-form'){event.preventDefault();saveItem(event.target);}
  if(event.target.id==='project-form'){
    event.preventDefault();const f=new FormData(event.target);
    try{state.catalog=validateCatalog({...state.catalog,name:f.get('name'),processName:f.get('processName')});state.approvals={};persist();dialog.close();render();toast('Project settings saved.');}catch(error){dialog.querySelector('#form-error').textContent=error.message;}
  }
  if(event.target.id==='new-project-form'){
    event.preventDefault();const f=new FormData(event.target);
    try{state.catalog=validateCatalog({schemaVersion:1,id:`project-${globalThis.crypto?.randomUUID?.()??Date.now().toString(36)}`,name:f.get('name'),processName:f.get('processName'),items:[]});state.runs=[];state.approvals={};state.baselines={};state.currentRunId=null;state.selectedId=null;state.mode='live';state.search='';state.filter='all';state.error='';state.buildLabel='First build';persist();dialog.close();render();toast('Catalog created. Add your first resolution recipe.');}catch(error){dialog.querySelector('#form-error').textContent=error.message;}
  }
});
document.addEventListener('keydown',event=>{
  if(state.mobile&&!dialog.open&&event.key==='Tab'){const controls=[document.querySelector('.nav-scrim'),...document.querySelectorAll('.sidebar a,.sidebar button:not(:disabled)')].filter(Boolean);const first=controls[0],last=controls.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}}
  if(dialog.classList.contains('command-dialog')&&dialog.open){
    const options=[...dialog.querySelectorAll('.command-option:not([hidden])')];
    if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();const i=options.indexOf(document.activeElement);const next=i<0?(event.key==='ArrowDown'?0:options.length-1):(i+(event.key==='ArrowDown'?1:-1)+options.length)%options.length;options[next]?.focus();}
    if(event.key==='Enter'&&event.target.id==='command-search'){event.preventDefault();options[0]?.click();}
  }
  const typing=event.target.matches('input,textarea,select,[contenteditable=true]');
  if(!dialog.open&&(event.metaKey||event.ctrlKey)&&event.key==='k'){event.preventDefault();showCommands();}
  if(!dialog.open&&event.key==='/'&&!typing){event.preventDefault();state.mobile=false;state.tab='catalog';state.filter='all';render();document.querySelector('#catalog-search')?.focus();}
  if(event.target.matches('.signature-select')&&['ArrowDown','ArrowUp'].includes(event.key)){event.preventDefault();const rows=[...document.querySelectorAll('.signature-select')];const i=rows.indexOf(event.target);const next=rows[Math.max(0,Math.min(rows.length-1,i+(event.key==='ArrowDown'?1:-1)))];next?.click();document.querySelector(`.signature-select[data-id='${next?.dataset.id}']`)?.focus();}
  if(event.key==='Enter'&&event.target.matches('.catalog-row')){event.preventDefault();state.selectedId=event.target.dataset.id;render();}
  if(event.key==='Escape'&&state.mobile){state.mobile=false;render();document.querySelector('.mobile-menu')?.focus();}
});
window.addEventListener('hashchange',()=>{const tab=location.hash.slice(1);if(['overview','catalog','history','exports'].includes(tab))navigate(tab);});


function revealInspector() {
  if(!window.matchMedia?.('(max-width: 1000px)').matches)return;
  const panel=document.querySelector('.inspector');
  panel?.focus({preventScroll:true});
  panel?.scrollIntoView({block:'start',behavior:'instant'});
}

function animateScanResult() {
  const gsap=globalThis.gsap;
  if(!gsap||window.matchMedia?.('(prefers-reduced-motion: reduce)').matches)return;
  gsap.killTweensOf('.build-summary, .map-cell');
  const cells=[...document.querySelectorAll('.map-cell')].slice(0,24);
  gsap.timeline({defaults:{ease:'power3.out'},onComplete(){gsap.set(cells,{clearProps:'transform,opacity'});}})
    .fromTo('.build-summary',{opacity:.75},{opacity:1,duration:.25})
    .fromTo(cells,{y:4,opacity:.5},{y:0,opacity:1,duration:.25,stagger:Math.min(.04,.25/Math.max(1,cells.length))},0);
}
function showCommands() {
  const commands=[['overview','Build overview','grid'],['catalog','Signature catalog','list'],['history','Build history','clock'],['exports','Export reviewed results','export']];
  showDialog('Jump to','Find a page or jump straight to a signature.',`<label class='command-search'>${icon('search',19)}<input id='command-search' placeholder='Search pages and signatures…' aria-label='Search commands' autocomplete='off'></label><div class='command-results'>${commands.map(([tab,label,glyph])=>`<button class='command-option' data-command-label='${esc(label.toLowerCase())}' data-action='nav' data-tab='${tab}'>${icon(glyph,18)}<span>${label}</span>${icon('arrow',14)}</button>`).join('')}${state.catalog.items.map(item=>`<button class='command-option' data-command-label='${esc((item.name+' '+item.module).toLowerCase())}' data-action='command-select' data-id='${esc(item.id)}'>${icon('scan',18)}<span>${esc(item.name)}<small>${esc(item.module)}</small></span>${icon('arrow',14)}</button>`).join('')}<p class='command-empty' hidden>No matching pages or signatures.</p></div>`);
  dialog.classList.add('command-dialog');
  dialog.querySelector('#command-search')?.focus();
}

async function initialize() {
  if(!state.runs.length&&state.catalog.id===DEMO_CATALOG.id&&hashCatalog(state.catalog)===hashCatalog(DEMO_CATALOG)){
    const baseline=await createDemoBaseline();state.runs.push(baseline);state.baselines.demo=baseline.id;
    const example=await checkBuild(state.catalog,{rpc:createDemoRpc('updated'),baseline,mode:'demo',label:'Build 1.8.3 · demo'});
    state.runs.push(example);state.currentRunId=example.id;persist();
  }
  render();await refreshConnection();setInterval(refreshConnection,15000);
}
initialize().catch(error=>{app.innerHTML=`<div class='boot'><div class='brand-mark'>+</div><h1>Workspace could not open</h1><p>${esc(error.message)}</p><p>Reload to try again. Your saved catalog has not been overwritten.</p></div>`;console.error(error);});
