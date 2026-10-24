import test from 'node:test';
import assert from 'node:assert/strict';
import { checkBuild } from '../shared/engine.mjs';
import { DEMO_CATALOG, createDemoRpc, createDemoBaseline } from '../shared/demo.mjs';
import { hex, hashItem } from '../shared/catalog.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
const run = (catalog, rpc, options = {}) => checkBuild(catalog, { rpc, mode: 'demo', label: 'Test build', ...options });
const fastDemo = scenario => createDemoRpc(scenario, { latencyMs: 0 });
const only = itemId => ({ ...copy(DEMO_CATALOG), items: copy(DEMO_CATALOG.items.filter(x => x.id === itemId)) });

function fixture({ base = 0xfedcba9876540000n, bytes = '00000000', item, scan = [], pointerBytes, relativeAddress } = {}) {
  const catalog = { schemaVersion: 1, id: 'fixture', name: 'Fixture', processName: 'test.exe', items: [item ?? { id: 'item', name: 'Item', module: 'test.exe', kind: 'rva', rva: '0x100', checks: [{ type: 'range', dataType: 'u32', min: '0', max: '100' }] }] };
  const rpc = async req => {
    if (req.type === 'ping') return { type: 'ping_result', attached: true, pid: 17, base: hex(base) };
    if (req.type === 'modules') return { type: 'modules_result', success: true, modules: [{ name: 'test.exe', base: hex(base), size: 0x10000 }] };
    if (req.type === 'sig_scan_ida') return { type: 'sig_scan_ida_result', success: scan.length > 0, results: scan };
    if (req.type === 'resolve_relative') return { type: 'resolve_relative_result', success: true, address: relativeAddress };
    if (req.type === 'read') {
      let data = pointerBytes && req.size === 8 ? pointerBytes : bytes;
      if (relativeAddress && scan.length && BigInt(req.address) === BigInt(scan[0]) + BigInt(item.relative.offset) && req.size === 4) {
        const buffer = new ArrayBuffer(4);
        new DataView(buffer).setInt32(0, Number(BigInt(relativeAddress) - BigInt(scan[0]) - BigInt(item.relative.instructionSize)), true);
        data = Array.from(new Uint8Array(buffer), b => b.toString(16).padStart(2, '0')).join('');
      }
      return { type: 'read_result', success: data !== null, address: req.address, size: data !== null ? req.size : 0, data: data?.slice(0, req.size * 2) ?? '' };
    }
    throw new Error(`Unexpected command ${req.type}`);
  };
  return { catalog, rpc };
}

test('the demo uses the resolver to produce all intended health states', async () => {
  const baseline = await createDemoBaseline();
  assert.equal(baseline.results.filter(x => x.status === 'valid').length, 8);
  const result = await run(DEMO_CATALOG, fastDemo('updated'), { baseline });
  assert.deepEqual(result.results.map(x => x.status), ['valid', 'moved', 'ambiguous', 'missing', 'invalid', 'valid', 'valid', 'valid', 'disabled']);
  assert.equal(result.results[1].previousRva, '0x301800');
  assert.equal(result.results[1].rva, '0x303c00');
  assert.equal(result.results[2].candidateCount, 2);
  assert.equal(result.results[2].address, undefined);
});
test('ASLR rebasing is normalized and heap allocation churn is not called movement', async () => {
  const baseline = await createDemoBaseline();
  const result = await run(DEMO_CATALOG, fastDemo('updated'), { baseline });
  assert.notEqual(result.target.base, baseline.target.base);
  assert.equal(result.results[0].status, 'valid');
  assert.equal(result.results[0].comparison, 'unchanged');
  assert.notEqual(result.results[5].address, baseline.results[5].address);
  assert.equal(result.results[5].status, 'valid');
  assert.equal(result.results[5].comparison, 'dynamic');
});
test('zero is a valid range value while unreadable memory is a read error', async () => {
  const f = fixture();
  const result = await run(f.catalog, f.rpc);
  assert.equal(result.results[0].status, 'valid');
  assert.equal(result.results[0].address, '0xfedcba9876540100');
  const broken = fixture({ bytes: null });
  assert.equal((await run(broken.catalog, broken.rpc)).results[0].status, 'error');
});
test('64-bit range comparisons do not round values through JavaScript Number', async () => {
  const f = fixture({ bytes: '0100000000002000', item: { id: 'item', name: 'Item', module: 'test.exe', kind: 'rva', rva: '0x100', checks: [{ type: 'range', dataType: 'u64', min: '9007199254740993', max: '9007199254740993' }] } });
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'valid');
  f.catalog.items[0].checks[0].max = '9007199254740992';
  f.catalog.items[0].checks[0].min = '9007199254740992';
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'invalid');
});
test('NaN does not pass a floating point range', async () => {
  const f = fixture({ bytes: '0000c07f', item: { id: 'item', name: 'Item', module: 'test.exe', kind: 'rva', rva: '0x100', checks: [{ type: 'range', dataType: 'f32', min: '0', max: '100' }] } });
  const r = (await run(f.catalog, f.rpc)).results[0];
  assert.equal(r.status, 'invalid');
  assert.match(r.checks.at(-1).detail, /NaN/);
});
test('ambiguous and missing signatures never attempt relative resolution or reads', async () => {
  for (const scan of [[], ['0xfedcba9876540100', '0xfedcba9876540200']]) {
    const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'signature', pattern: '48 8B 05 ?? ?? ?? ??', relative: { offset: 3, instructionSize: 7 }, checks: [] };
    const f = fixture({ item, scan });
    const seen = [];
    const result = await run(f.catalog, async req => { seen.push(req); return f.rpc(req); });
    assert.equal(result.results[0].status, scan.length ? 'ambiguous' : 'missing');
    assert.equal(seen.some(x => x.type === 'read' || x.type === 'resolve_relative'), false);
    assert.equal(seen.find(x => x.type === 'sig_scan_ida').find_all, true);
  }
});
test('relative resolution uses the portable RPC offset and inst_size fields', async () => {
  const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'signature', pattern: '48 8B 05 ?? ?? ?? ??', relative: { offset: 3, instructionSize: 7 }, addend: '-0x10', checks: [] };
  const f = fixture({ item, scan: ['0xfedcba9876540100'], relativeAddress: '0xfedcba9876540080' });
  let relative;
  const result = await run(f.catalog, async req => { if (req.type === 'resolve_relative') relative = req; return f.rpc(req); });
  assert.deepEqual(relative, { type: 'resolve_relative', address: '0xfedcba9876540100', offset: 3, inst_size: 7 });
  assert.equal(result.results[0].address, '0xfedcba9876540070');
});
test('an incorrect relative response cannot override the actual signed rel32 displacement', async () => {
  const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'signature', pattern: '48 8B 05 ?? ?? ?? ??', relative: { offset: 3, instructionSize: 7 }, checks: [] };
  const f = fixture({ item, scan: ['0xfedcba9876540100'], relativeAddress: '0xfedcba9876540080' });
  const result = await run(f.catalog, async req => {
    const response = await f.rpc(req);
    if (req.type === 'resolve_relative') response.address = '0xfedcba9876540081';
    return response;
  });
  assert.equal(result.results[0].status, 'error');
  assert.match(result.results[0].message, /signed rel32/);
});
test('pointer nulls fail before adding an offset and 32-bit pointer values are supported', async () => {
  const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'pointer', rva: '0x100', pointerSize: 8, offsets: ['0x40'], checks: [] };
  const f = fixture({ item, pointerBytes: '0000000000000000' });
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'invalid');
  item.pointerSize = 4;
  const g = fixture({ item, base: 0x400000n, bytes: '00104000' });
  assert.equal((await run(g.catalog, g.rpc)).results[0].address, '0x401040');
});
test('address arithmetic rejects overflow and rvas outside the source module', async () => {
  const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'rva', rva: '0x100', addend: '0x7fffffffffffffff', checks: [] };
  const f = fixture({ item });
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'invalid');
  item.rva = '0x10000'; item.addend = '0';
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'invalid');
});
test('definition changes cannot inherit accepted movement comparisons', async () => {
  const catalog = only('view-matrix');
  const baseline = await run(catalog, fastDemo('baseline'));
  catalog.items[0].checks.push({ type: 'alignment', value: 8 });
  const current = (await run(catalog, fastDemo('updated'), { baseline })).results[0];
  assert.notEqual(current.definitionHash, baseline.results[0].definitionHash);
  assert.equal(current.status, 'valid');
  assert.equal(current.comparison, 'definition_changed');
  assert.equal(current.definitionHash, hashItem(catalog.items[0]));
});
test('a different catalog or demo/live mode cannot be used as a baseline', async () => {
  const baseline = await createDemoBaseline();
  await assert.rejects(() => checkBuild(DEMO_CATALOG, { rpc: fastDemo('updated'), baseline, mode: 'live' }), /different catalog or connection mode/);
  const other = { ...DEMO_CATALOG, id: 'other' };
  await assert.rejects(() => run(other, fastDemo('updated'), { baseline }), /different catalog/);
});
test('a target PID change discards the entire run even after item progress', async () => {
  const rpc = fastDemo('baseline'); let pingCount = 0; let progress = 0;
  await assert.rejects(() => run(only('world-state'), async req => {
    const response = await rpc(req);
    if (req.type === 'ping' && ++pingCount > 1) response.pid++;
    return response;
  }, { onProgress: () => progress++ }), /Target changed/);
  assert.equal(progress, 1);
});
test('module relocation during a run is rejected and a wrong process is rejected upfront', async () => {
  const rpc = fastDemo('baseline'); let moduleCount = 0;
  await assert.rejects(() => run(only('world-state'), async req => {
    const response = await rpc(req);
    if (req.type === 'modules' && ++moduleCount > 1) response.modules[1].size++;
    return response;
  }), /Target changed/);
  const catalog = { ...only('world-state'), processName: 'other.exe' };
  await assert.rejects(() => run(catalog, fastDemo('baseline')), /Expected other.exe/);
});
test('cancellation never returns a partially checked build', async () => {
  const controller = new AbortController();
  let count = 0;
  await assert.rejects(() => run(DEMO_CATALOG, fastDemo('baseline'), {
    signal: controller.signal,
    onProgress: () => { count++; controller.abort(); },
  }), e => e.name === 'AbortError');
  assert.equal(count, 1);
});
test('partial reads and malformed result types are errors, never valid checks', async () => {
  const f = fixture({ bytes: '00' });
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'error');
  const g = fixture();
  const current = await run(g.catalog, async req => req.type === 'read' ? { type: 'write_result', success: true, data: '00000000' } : g.rpc(req));
  assert.equal(current.results[0].status, 'error');
});
test('mismatched read address and size cannot be consumed as successful samples', async () => {
  for (const corrupt of [r => { r.address = '0x1'; }, r => { r.size++; }]) {
    const f = fixture();
    const result = await run(f.catalog, async req => { const response = await f.rpc(req); if (req.type === 'read') corrupt(response); return response; });
    assert.equal(result.results[0].status, 'error');
  }
});
test('byte masks, alignment and module membership are validated independently', async () => {
  const item = { id: 'item', name: 'Item', module: 'test.exe', kind: 'rva', rva: '0x100', checks: [{ type: 'bytes', pattern: '48 ?? 05' }, { type: 'alignment', value: 16 }, { type: 'in_module', module: 'test.exe' }] };
  const f = fixture({ item, bytes: '488b05' });
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'valid');
  item.checks[0].pattern = '48 ?? 06';
  assert.equal((await run(f.catalog, f.rpc)).results[0].status, 'invalid');
});
