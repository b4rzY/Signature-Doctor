import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWorkspace, saveWorkspace, retainRun } from '../public/store.mjs';
import { DEMO_CATALOG, createDemoBaseline, createDemoRpc } from '../shared/demo.mjs';
import { checkBuild } from '../shared/engine.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const baseline = await createDemoBaseline();
const updated = await checkBuild(DEMO_CATALOG, { rpc: createDemoRpc('updated', { latencyMs: 0 }), baseline, mode: 'demo', label: 'Updated fixture' });
function workspace() { return { catalog: copy(DEMO_CATALOG), runs: [copy(baseline), copy(updated)], approvals: { [updated.id]: ['world-state'] }, baselines: { demo: baseline.id }, mode: 'demo' }; }
function storage(value) {
  let raw = value;
  let writes = 0;
  globalThis.localStorage = { getItem: () => raw, setItem: (_key, value) => { raw = value; writes++; } };
  return { raw: () => raw, writes: () => writes };
}

test('absent storage is a first launch; an empty existing value is a recovery case', () => {
  storage(null); assert.equal(loadWorkspace(), null);
  const s = storage('');
  assert.equal(loadWorkspace().storageIssue.raw, '');
  assert.equal(s.writes(), 0);
});
test('valid saved reports, mode-specific baseline and per-run approvals round-trip', () => {
  storage(JSON.stringify(workspace()));
  const loaded = loadWorkspace();
  assert.equal(loaded.storageIssue, undefined);
  assert.equal(loaded.runs.length, 2);
  assert.equal(loaded.baselines.demo, baseline.id);
  assert.deepEqual(loaded.approvals[updated.id], ['world-state']);
  saveWorkspace(loaded);
  assert.deepEqual(loadWorkspace(), loaded);
});
test('malformed JSON and invalid catalogs preserve the original bytes for recovery', () => {
  for (const raw of ['{broken JSON', JSON.stringify({ catalog: { ...DEMO_CATALOG, schemaVersion: 2 } })]) {
    const s = storage(raw); const loaded = loadWorkspace();
    assert.equal(loaded.storageIssue.raw, raw);
    assert.equal(s.raw(), raw); assert.equal(s.writes(), 0);
    assert.throws(() => saveWorkspace({ ...workspace(), storageIssue: loaded.storageIssue }), /explicitly replace/);
    assert.equal(s.raw(), raw);
  }
});
test('storage access failures are distinct from an empty workspace', () => {
  globalThis.localStorage = { getItem() { throw new Error('Storage blocked'); }, setItem() { throw new Error('Must not write'); } };
  const loaded = loadWorkspace();
  assert.equal(loaded.storageIssue.raw, null);
  assert.match(loaded.storageIssue.message, /unavailable/);
});
test('malformed nested report data is rejected without discarding the original workspace', () => {
  const mutations = [
    r => { r.results[0].trace = [null]; },
    r => { r.results[0].checks = [null]; },
    r => { r.results[0].checks[0].passed = 'true'; },
    r => { r.results[0].checks[0].detail = {}; },
    r => { r.results[0].trace[0].value = []; },
    r => { r.target.pid = '<img src=x>'; },
    r => { r.target.modules = [null]; },
    r => { r.target.modules[0].base = 42; },
    r => { r.target.modules[0].size = -1; },
    r => { r.results[0].address = '0x10000000000000000'; },
    r => { r.results[2].candidates = [null]; },
    r => { r.results[2].candidateCount = -1; },
    r => { r.results[0].comparison = 'trusted'; },
    r => { r.startedAt = 'not a date'; },
    r => { r.results.push(copy(r.results[0])); },
    r => { r.results[0].definitionHash = '0'.repeat(64); },
  ];
  for (const mutate of mutations) {
    const data = workspace(); mutate(data.runs[1]); const raw = JSON.stringify(data); const s = storage(raw);
    const loaded = loadWorkspace();
    assert.ok(loaded.storageIssue, mutate.toString());
    assert.equal(loaded.storageIssue.raw, raw);
    assert.equal(loaded.catalog.id, DEMO_CATALOG.id);
    assert.equal(s.writes(), 0);
  }
});
test('stale reports remain inspectable but cannot restore approvals for changed definitions', () => {
  const data = workspace(); data.catalog.items[0].checks.push({ type: 'alignment', value: 8 });
  storage(JSON.stringify(data));
  const loaded = loadWorkspace();
  assert.equal(loaded.storageIssue, undefined);
  assert.equal(loaded.runs.length, 2);
  assert.deepEqual(loaded.approvals[updated.id], []);
});
test('cross-environment baseline IDs and duplicate approval selections trigger recovery', () => {
  for (const mutate of [
    data => { data.baselines.live = baseline.id; },
    data => { data.approvals[updated.id] = ['world-state', 'world-state']; },
    data => { data.approvals[updated.id] = ['entity-list']; },
    data => { data.approvals.absent = []; },
    data => { data.runs[1].id = data.runs[0].id; },
  ]) {
    const data = workspace(); mutate(data); const raw = JSON.stringify(data); storage(raw);
    assert.equal(loadWorkspace().storageIssue.raw, raw);
  }
});
test('retention preserves both environment baselines and removes evicted approvals', () => {
  const state = { runs: [], approvals: {}, baselines: { demo: 'run-0', live: 'run-1' } };
  for (let i = 0; i < 24; i++) { const id = `run-${i}`; state.approvals[id] = ['item']; retainRun(state, { id }); }
  assert.equal(state.runs.length, 20);
  assert.ok(state.runs.some(r => r.id === 'run-0'));
  assert.ok(state.runs.some(r => r.id === 'run-1'));
  assert.ok(!state.runs.some(r => r.id === 'run-2'));
  assert.equal(state.approvals['run-2'], undefined);
});
