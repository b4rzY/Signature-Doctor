import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { createDemoRpc } from '../shared/demo.mjs';

// DOM interaction tests, not a substitute for real-browser layout verification.
test('dashboard interaction flow keeps review, history, edits, and demo/live state consistent', async t => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  await mkdir(join(root, 'tmp'), { recursive: true });
  const temp = await mkdtemp(join(root, 'tmp', 'ui-'));
  const dom = new JSDOM(await readFile(join(root, 'public/index.html'), 'utf8'), { url: 'http://localhost:3210/', pretendToBeVisual: true });
  const { window } = dom;
  const names = ['window','document','localStorage','navigator','location','FormData','fetch','setInterval'];
  const descriptors = Object.fromEntries(names.map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  const nativeFetch = globalThis.fetch;
  const intervals=[];const downloads=[];
  for(const [name,value] of Object.entries({window,document:window.document,localStorage:window.localStorage,navigator:window.navigator,location:window.location,FormData:window.FormData})) Object.defineProperty(globalThis,name,{value,writable:true,configurable:true});
  let runtimeConnected=false;
  const simulatedRuntime=createDemoRpc('updated',{latencyMs:0});
  globalThis.fetch=async (url,options)=>{
    if(url==='/api/status')return new Response(JSON.stringify({agentConnected:runtimeConnected,attached:runtimeConnected,mode:'direct',upstream:null,pendingRequests:0,version:'1.1.0'}),{status:200,headers:{'content-type':'application/json'}});
    if(url==='/api/rpc'&&runtimeConnected)return new Response(JSON.stringify(await simulatedRuntime(JSON.parse(options.body),options.signal)),{status:200,headers:{'content-type':'application/json'}});
    throw new Error(`Unexpected test request ${url}`);
  };
  globalThis.setInterval=(fn,ms)=>{const id=descriptors.setInterval.value(fn,ms);intervals.push(id);return id;};
  window.HTMLDialogElement.prototype.showModal=function(){this.open=true;};
  window.HTMLDialogElement.prototype.close=function(){this.open=false;};
  window.HTMLAnchorElement.prototype.click=function(){downloads.push({filename:this.download,href:this.href});};
  const q=selector=>window.document.querySelector(selector);
  const click=selector=>{const el=q(selector);assert.ok(el,`Element exists: ${selector}`);assert.notEqual(el.disabled,true,`Element is enabled: ${selector}`);el.click();};
  const fill=(selector,value)=>{const el=q(selector);assert.ok(el,selector);el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));};
  const waitFor=async(predicate,label)=>{const until=Date.now()+10000;while(!predicate()){if(Date.now()>until)throw new Error(`Timed out: ${label}\n${window.document.body.textContent.slice(0,1500)}`);await new Promise(resolve=>setTimeout(resolve,15));}};
  const storage=()=>JSON.parse(window.localStorage.getItem('signature-doctor.workspace.v1'));
  try {
    // Keep production ESM intact; only remap root-relative browser imports in an isolated test copy.
    for(const name of ['app.mjs','store.mjs','icons.mjs']){
      const source=(await readFile(join(root,'public',name),'utf8')).replace(/from '(?:\/|\.\.\/)shared\/([^']+)'/g,(_,file)=>`from '${pathToFileURL(join(root,'shared',file)).href}'`);
      await writeFile(join(temp,name),source);
    }
    await import(pathToFileURL(join(temp,'app.mjs')).href);
    await waitFor(()=>q('.catalog-row'),'initial demo check');

    await t.test('demo uses computed statuses and opens the moved-result inspector',()=>{
      assert.equal(window.document.querySelectorAll('.catalog-row').length,9);
      assert.match(q('.context-copy').textContent,/simulated process data/i);
      assert.match(q('.inspector').textContent,/ViewMatrix/);
      assert.equal(storage().runs.length,2);
      assert.equal(storage().runs.at(-1).mode,'demo');
      assert.equal(storage().runs.at(-1).results.filter(x=>x.status==='moved').length,1);
    });

    await t.test('command search supports keyboard selection and empty results',()=>{
      q('[data-action=commands]').dispatchEvent(new window.KeyboardEvent('keydown',{key:'k',ctrlKey:true,bubbles:true}));
      assert.equal(q('#dialog').open,true);
      fill('#command-search','no-such-signature');
      assert.equal(q('.command-empty').hidden,false);
      fill('#command-search','ViewMatrix');
      assert.equal(window.document.querySelectorAll('.command-option:not([hidden])').length,1);
      q('#command-search').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      assert.equal(q('#dialog').open,false);
      assert.match(q('.inspector').textContent,/ViewMatrix/);
      click('[data-action=filter][data-filter=attention]');
      q('[data-action=filter][data-filter=all]').focus();
      click('[data-action=filter][data-filter=all]');
      assert.equal(window.document.activeElement.dataset.filter,'all');
    });

    await t.test('stacked inspection and mobile navigation preserve focus',()=>{
      window.matchMedia=()=>({matches:true});
      window.HTMLElement.prototype.scrollIntoView=function(){};
      click('.map-cell[data-id=view-matrix]');
      assert.equal(window.document.activeElement.getAttribute('aria-label'),'Selected signature details');
      click('[data-action=back-to-results]');
      assert.equal(window.document.activeElement.dataset.id,'view-matrix');
      click('.mobile-menu');
      assert.equal(q('.main-wrap').hasAttribute('inert'),true);
      assert.equal(window.document.activeElement.className,'brand');
      q('.brand').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      assert.equal(q('.main-wrap').hasAttribute('inert'),false);
      assert.equal(window.document.activeElement.getAttribute('aria-label'),'Toggle navigation');
      click('.mobile-menu');click('[data-action=commands]');fill('#command-search','ViewMatrix');
      q('#command-search').dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
      assert.equal(q('.main-wrap').hasAttribute('inert'),false);
      assert.equal(window.document.activeElement.getAttribute('aria-label'),'Selected signature details');
      click('.mobile-menu');q('.brand').dispatchEvent(new window.KeyboardEvent('keydown',{key:'/',bubbles:true}));
      assert.equal(q('.main-wrap').hasAttribute('inert'),false);
      assert.equal(window.document.activeElement.id,'catalog-search');
      click('[data-action=nav][data-tab=overview]');
      delete window.matchMedia;
    });

    await t.test('search and attention filters select the intended rows',()=>{
      fill('#catalog-search','ViewMatrix');
      assert.equal(window.document.querySelectorAll('.catalog-row').length,1);
      fill('#catalog-search','');click('[data-action=filter][data-filter=attention]');
      assert.equal(window.document.querySelectorAll('.catalog-row').length,4);
      click('[data-action=filter][data-filter=all]');
    });

    await t.test('approving exports only that reviewed result and marks demo manifests',async()=>{
      click('[data-action=select][data-id=view-matrix]');click('[data-action=approve]');
      click('[data-action=nav][data-tab=exports]');
      assert.match(q('.export-overview').textContent,/1 reviewed result/);
      assert.equal(q('[data-action=angelscript]').disabled,true);
      click('[data-action=manifest]');
      await waitFor(()=>downloads.length>0,'manifest download');
      const exported=await (await nativeFetch(downloads.at(-1).href)).json();
      assert.equal(exported.mode,'demo');assert.equal(exported.entries.length,1);
      assert.equal(exported.entries[0].id,'view-matrix');
    });

    await t.test('a new check never inherits approval and the completed previous run retains its review',async()=>{
      click('[data-action=nav][data-tab=overview]');
      const oldId=storage().runs.at(-1).id;
      click('[data-action=scan]');
      await waitFor(()=>storage().runs.length===3&&!q('[data-action=cancel]'),'new check completion');
      const saved=storage();assert.deepEqual(saved.approvals[saved.runs.at(-1).id],[]);assert.deepEqual(saved.approvals[oldId],['view-matrix']);
      click('[data-action=nav][data-tab=history]');click(`[data-action=view-run][data-id='${oldId}']`);
      assert.match(q('[data-action=approve]').textContent,/Approved/);
    });

    await t.test('the recipe editor preserves checks and invalidates stale approvals',()=>{
      click('[data-action=edit][data-id=view-matrix]');
      assert.equal(q('#dialog').open,true);
      const oldChecks=storage().catalog.items.find(i=>i.id==='view-matrix').checks;
      fill('#item-form [name=notes]','Reviewed in the DOM interaction test.');
      q('#item-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
      assert.equal(q('#dialog').open,false);
      assert.deepEqual(storage().catalog.items.find(i=>i.id==='view-matrix').checks,oldChecks);
      assert.deepEqual(storage().approvals,{});
      assert.match(q('.inline-alert').textContent,/catalog has changed/i);
      assert.equal(q('[data-action=approve]').disabled,true);
    });

    await t.test('a malformed recipe shows a useful error instead of modifying the catalog',()=>{
      click('[data-action=add]');fill('#item-form [name=name]','BrokenPattern');fill('#item-form [name=pattern]','?? ??');
      q('#item-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
      assert.equal(q('#dialog').open,true);assert.match(q('#form-error').textContent,/concrete byte/i);
      assert.equal(storage().catalog.items.length,9);click('[data-action=close-dialog]');
    });

    await t.test('live mode has isolated history and reports a disconnected runtime without fake results',async()=>{
      click('[data-action=mode][data-mode=live]');
      assert.equal(q('[data-action=approve]').disabled,true);
      click('[data-action=scan]');await waitFor(()=>q('.inline-alert.error'),'live connection failure');
      assert.match(q('.inline-alert.error').textContent,/runtime is offline/);
      assert.equal(storage().runs.filter(r=>r.mode==='live').length,0);
      click('[data-action=connect]');assert.equal(q('#dialog').open,true);
      assert.match(q('#dialog').textContent,/examples\/angelscript-connect\.as/);
      click('[data-action=setup-proxy]');assert.match(q('#dialog').textContent,/WEB_MV_URL/);
      click('[data-action=close-dialog]');
    });

    await t.test('a compatible runtime completes the live review and AngelScript export flow',async()=>{
      runtimeConnected=true;
      click('[data-action=scan]');
      await waitFor(()=>storage().runs.some(r=>r.mode==='live')&&!q('[data-action=cancel]'),'live check completion');
      assert.match(q('.connection-pill').textContent,/Runtime connected/);
      assert.equal(q('.inline-alert.error'),null);
      click('[data-action=select][data-id=view-matrix]');click('[data-action=approve]');
      click('[data-action=nav][data-tab=exports]');
      assert.equal(q('[data-action=angelscript]').disabled,false);
      const before=downloads.length;
      click('[data-action=angelscript]');
      await waitFor(()=>downloads.length>before,'live AngelScript download');
      const artifact=downloads.at(-1);
      assert.match(artifact.filename,/\.resolvers\.as$/);
      const source=await (await nativeFetch(artifact.href)).text();
      assert.match(source,/process::find_signatures/);
      assert.match(source,/process::read_/);
      assert.doesNotMatch(source,/process::open_socket|\bEch[o0]\b/i);
      assert.equal(storage().runs.filter(r=>r.mode==='live').length,1);
      assert.ok(storage().runs.some(r=>r.mode==='demo'));
    });

    await t.test('a new catalog starts empty in live mode and a new recipe can be saved',()=>{
      click('[data-action=nav][data-tab=catalog]');click('[data-action=new-project]');
      fill('#new-project-form [name=name]','My diagnostics');fill('#new-project-form [name=processName]','MyApp.exe');
      q('#new-project-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
      assert.equal(q('#dialog').open,false);assert.equal(storage().catalog.items.length,0);assert.equal(storage().mode,'live');assert.equal(storage().runs.length,0);
      click('[data-action=add]');fill('#item-form [name=name]','MainState');fill('#item-form [name=pattern]','48 8B 05 ?? ?? ?? ??');
      q('#item-form').dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
      assert.equal(q('#dialog').open,false);assert.equal(storage().catalog.items.length,1);assert.equal(storage().catalog.items[0].module,'MyApp.exe');
      assert.equal(storage().catalog.items[0].checks[0].type,'readable');
    });
  } finally {
    intervals.forEach(clearInterval);dom.window.close();
    for(const name of names){if(descriptors[name])Object.defineProperty(globalThis,name,descriptors[name]);else delete globalThis[name];}
    await rm(temp,{recursive:true,force:true});
  }
});
