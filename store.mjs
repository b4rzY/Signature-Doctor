import { validateCatalog, hashCatalog, hashItem, parseAddress, U64_MAX } from '../shared/catalog.mjs';
import { STATUS } from '../shared/model.mjs';
const KEY = 'signature-doctor.workspace.v1';
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const HASH = /^[0-9a-f]{64}$/;
const COMPARISONS = new Set(['new', 'unchanged', 'moved', 'definition_changed', 'dynamic']);

function fail(label, message) { throw new Error(`${label}: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'expected an object');
  return value;
}
function text(value, label, max = 8000, empty = true) {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.length) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(label, 'invalid text');
}
function identifier(value, label) { if (typeof value !== 'string' || !ID.test(value)) fail(label, 'invalid identifier'); }
function address(value, label, nonzero = false) {
  if (typeof value !== 'string') fail(label, 'address must be a string');
  const n = parseAddress(value, label);
  if (nonzero && !n) fail(label, 'address must not be zero');
  return n;
}
function timestamp(value, label) {
  if (typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) fail(label, 'invalid timestamp');
}
function array(value, label, max) { if (!Array.isArray(value) || value.length > max) fail(label, `expected an array of at most ${max} entries`); }

function validateRun(value, catalog, currentHash) {
  const run = object(value, 'Build report');
  identifier(run.id, 'Report ID');
  const label = `Report ${run.id}`;
  if (run.schemaVersion !== 1 || run.catalogId !== catalog.id || !['demo', 'live'].includes(run.mode)) fail(label, 'unsupported schema, catalog, or environment');
  if (typeof run.catalogHash !== 'string' || !HASH.test(run.catalogHash)) fail(label, 'invalid catalog fingerprint');
  text(run.label, `${label} label`, 120, false);
  timestamp(run.startedAt, `${label} start`); timestamp(run.completedAt, `${label} completion`);
  if (run.baselineId !== undefined) identifier(run.baselineId, `${label} baseline`);
  const target = object(run.target, `${label} target`);
  if (!Number.isSafeInteger(target.pid) || target.pid <= 0) fail(label, 'invalid target PID');
  const base = address(target.base, `${label} process base`, true);
  array(target.modules, `${label} modules`, 4096);
  if (!target.modules.length) fail(label, 'module list is empty');
  const modules = new Set();
  for (const value of target.modules) {
    const module = object(value, `${label} module`);
    text(module.name, `${label} module name`, 512, false);
    if (/[\r\n\t]/.test(module.name)) fail(label, 'invalid module filename');
    const moduleBase = address(module.base, `${label} module base`, true);
    if (!Number.isSafeInteger(module.size) || module.size <= 0 || moduleBase + BigInt(module.size) - 1n > U64_MAX) fail(label, 'invalid module extent');
    if (modules.has(module.name.toLowerCase())) fail(label, 'duplicate module names');
    modules.add(module.name.toLowerCase());
  }
  if (!target.modules.some(m => parseAddress(m.base) === base)) fail(label, 'main module is missing');
  array(run.results, `${label} results`, 250);
  const resultIds = new Set();
  for (const value of run.results) {
    const result = object(value, `${label} result`);
    identifier(result.id, `${label} result ID`);
    if (resultIds.has(result.id)) fail(label, 'duplicate result IDs');
    resultIds.add(result.id);
    if (!Object.hasOwn(STATUS, result.status)) fail(label, 'unknown result status');
    text(result.message, `${label} message`);
    if (typeof result.definitionHash !== 'string' || !HASH.test(result.definitionHash)) fail(label, 'invalid definition fingerprint');
    if (!Number.isFinite(result.durationMs) || result.durationMs < 0) fail(label, 'invalid result duration');
    array(result.checks, `${label} checks`, 17);
    for (const value of result.checks) {
      const check = object(value, `${label} check`);
      text(check.label, `${label} check label`, 512, false); text(check.detail, `${label} check detail`);
      if (typeof check.passed !== 'boolean') fail(label, 'invalid check verdict');
    }
    array(result.trace, `${label} trace`, 32);
    for (const value of result.trace) {
      const step = object(value, `${label} trace step`);
      text(step.label, `${label} step label`, 512, false); text(step.value, `${label} step value`);
    }
    for (const key of ['address', 'rva', 'previousRva', 'sourceRva', 'previousSourceRva']) {
      if (result[key] !== undefined) address(result[key], `${label} ${key}`, key === 'address');
    }
    for (const key of ['module', 'sourceModule']) if (result[key] !== undefined) text(result[key], `${label} ${key}`, 512, false);
    if (result.comparison !== undefined && !COMPARISONS.has(result.comparison)) fail(label, 'unknown comparison state');
    if (result.candidates !== undefined) {
      array(result.candidates, `${label} candidates`, 32);
      for (const candidate of result.candidates) address(candidate, `${label} candidate`, true);
    }
    if (result.candidateCount !== undefined && (!Number.isSafeInteger(result.candidateCount) || result.candidateCount < 1 || result.candidateCount < (result.candidates?.length ?? 0))) fail(label, 'invalid candidate count');
    if (['valid', 'moved'].includes(result.status) && (!result.address || !result.checks.length || result.checks.some(c => c.passed !== true))) fail(label, 'passing result has missing or failed evidence');
    if (run.catalogHash === currentHash) {
      const item = catalog.items.find(item => item.id === result.id);
      if (!item || hashItem(item) !== result.definitionHash) fail(label, 'result definition does not match its catalog fingerprint');
    }
  }
  if (run.catalogHash === currentHash && run.results.length !== catalog.items.length) fail(label, 'completed report is missing catalog results');
  return run;
}

export function loadWorkspace() {
  let raw = null;
  let catalog;
  try {
    raw = localStorage.getItem(KEY);
    if (raw === null) return null;
    if (raw.length > 6_000_000) throw new Error('Saved workspace exceeds the 6 MB read limit');
    const data = object(JSON.parse(raw), 'Workspace');
    catalog = validateCatalog(data.catalog);
    const currentHash = hashCatalog(catalog);
    const savedRuns = data.runs ?? [];
    array(savedRuns, 'Saved reports', 20);
    const runs = savedRuns.map(run => validateRun(run, catalog, currentHash));
    if (new Set(runs.map(r => r.id)).size !== runs.length) throw new Error('Saved reports have duplicate IDs');
    const savedApprovals = data.approvals === undefined ? {} : object(data.approvals, 'Saved approvals');
    const approvals = Object.create(null);
    for (const run of runs) {
      const ids = savedApprovals[run.id] ?? [];
      array(ids, `Approvals for ${run.id}`, 250);
      if (ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new Error('Saved approvals contain invalid or duplicate IDs');
      if (ids.some(id => !run.results.some(r => r.id === id && ['valid', 'moved'].includes(r.status)))) throw new Error('Saved approval refers to a missing or non-passing result');
      approvals[run.id] = run.catalogHash === currentHash ? ids.filter(id => catalog.items.some(item => item.id === id && item.enabled)) : [];
    }
    if (Object.keys(savedApprovals).some(id => !runs.some(run => run.id === id))) throw new Error('Saved approvals refer to an absent report');
    const savedBaselines = data.baselines === undefined ? {} : object(data.baselines, 'Saved baselines');
    const baselines = {};
    for (const mode of ['demo', 'live']) {
      if (savedBaselines[mode] === undefined) continue;
      if (!runs.some(r => r.id === savedBaselines[mode] && r.mode === mode)) throw new Error('Saved baseline refers to an absent report or a different environment');
      baselines[mode] = savedBaselines[mode];
    }
    if (data.mode !== undefined && !['demo', 'live'].includes(data.mode)) throw new Error('Saved environment is invalid');
    return { catalog, runs, approvals, baselines, mode: data.mode === 'live' ? 'live' : 'demo' };
  } catch (error) {
    return { ...(catalog ? { catalog } : {}), storageIssue: { raw, message: raw === null ? 'Browser storage is unavailable. Changes will remain in memory until storage is available.' : `Saved workspace needs recovery: ${error.message}. The saved data has been preserved.` } };
  }
}
export function saveWorkspace(state) {
  if (state.storageIssue) throw new Error('Resolve or explicitly replace the saved workspace before saving new data.');
  localStorage.setItem(KEY, JSON.stringify({ catalog: state.catalog, runs: state.runs, approvals: state.approvals, baselines: state.baselines, mode: state.mode }));
}
export function retainRun(state, run) {
  state.runs.push(run);
  while (state.runs.length > 20) {
    const remove = state.runs.findIndex(r => !Object.values(state.baselines).includes(r.id));
    const [old] = state.runs.splice(remove < 0 ? 0 : remove, 1);
    delete state.approvals[old.id];
  }
}
