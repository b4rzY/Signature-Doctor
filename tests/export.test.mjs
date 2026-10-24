import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCatalog, hashCatalog, hashItem } from '../shared/catalog.mjs';
import { createManifest, generateAngelScript } from '../shared/export.mjs';

function fixture(overrides = {}) {
  const catalog = validateCatalog({
    schemaVersion: 1, id: 'test-project', name: 'Export fixture', processName: 'Fixture.exe',
    items: [
      { id: 'camera-root', name: 'Camera root', module: 'Fixture.exe', kind: 'signature',
        pattern: '48 8B 05 ?? ?? ?? ??', relative: { offset: 3, instructionSize: 7 },
        checks: [{ type: 'readable', size: 8 }, { type: 'alignment', value: 8 }] },
      { id: 'count', name: 'Object count', module: 'Fixture.exe', kind: 'rva', rva: '0x2000',
        checks: [{ type: 'range', dataType: 'u32', min: '0', max: '10000' }] },
    ],
    ...overrides,
  });
  const run = {
    schemaVersion: 1, id: 'run-001', catalogId: catalog.id, catalogHash: hashCatalog(catalog),
    label: 'Fixture build', mode: 'live', startedAt: '2026-10-24T00:00:00.000Z',
    completedAt: '2026-10-24T00:00:01.000Z',
    target: { pid: 42, base: '0x140000000', modules: [{ name: 'Fixture.exe', base: '0x140000000', size: 65536 }] },
    results: catalog.items.map(item => ({
      id: item.id, status: 'valid', address: '0x140002000', module: 'Fixture.exe', rva: '0x2000',
      checks: (item.checks.length ? item.checks : [{ type: 'readable' }]).map(check => ({ label: check.type, passed: true, detail: 'ok' })),
      trace: [], message: 'Valid', durationMs: 1, definitionHash: hashItem(item),
    })),
  };
  return { catalog, run };
}

test('exports only explicitly reviewed eligible entries and keeps resolution recipes', () => {
  const { catalog, run } = fixture();
  const manifest = createManifest(catalog, run, ['camera-root']);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].resolver.pattern, '48 8B 05 ?? ?? ?? ??');
  assert.equal(manifest.entries[0].observed.address, '0x140002000');
  assert.equal(manifest.entries[0].resolver.address, undefined);
  assert.equal(manifest.demo, false);
  manifest.entries[0].checks[0].size = 1;
  assert.equal(catalog.items[0].checks[0].size, 8);
});

test('empty, unknown, duplicate and failed review selections cannot export', () => {
  const { catalog, run } = fixture();
  assert.throws(() => createManifest(catalog, run, []), /Review at least/);
  assert.throws(() => createManifest(catalog, run, ['absent']), /not a valid/);
  assert.throws(() => createManifest(catalog, run, ['count', 'count']), /duplicate/);
  run.results[0].status = 'ambiguous';
  assert.throws(() => createManifest(catalog, run, ['camera-root']), /not a valid/);
  run.results[0].status = 'moved';
  run.results[0].checks[0].passed = false;
  assert.throws(() => createManifest(catalog, run, ['camera-root']), /failed validation/);
});

test('stale catalog and item definitions invalidate export approval', () => {
  const { catalog, run } = fixture();
  const changed = structuredClone(catalog);
  changed.items[0].pattern = '90 90';
  assert.throws(() => createManifest(changed, run, ['camera-root']), /catalog changed/);
  run.results[0].definitionHash = 'stale';
  assert.throws(() => createManifest(catalog, run, ['camera-root']), /changed after the check/);
});

test('demo data is marked in JSON and cannot produce a runnable AngelScript export', () => {
  const { catalog, run } = fixture();
  run.mode = 'demo';
  assert.equal(createManifest(catalog, run, ['count']).demo, true);
  assert.match(createManifest(catalog, run, ['count']).notice, /DEMO DATA/);
  assert.throws(() => generateAngelScript(catalog, run, ['count']), /requires a live check/);
});

test('generated signatures demand uniqueness and verify signed relative references', () => {
  const { catalog, run } = fixture();
  const code = generateAngelScript(catalog, run, ['camera-root']);
  assert.match(code, /find_signatures\(module_base,/);
  assert.match(code, /hits\.length\(\) != 1/);
  assert.match(code, /read_int32\(displacement_address, displacement\)/);
  assert.match(code, /uint64\(-int64\(displacement\)\)/);
  assert.match(code, /relative_target != expected/);
  assert.match(code, /candidate % 8/);
  assert.match(code, /sd_readable\(candidate, 8\)/);
  assert.doesNotMatch(code, /0x140002000/);
  assert.doesNotMatch(code, /process::write/);
});

test('pointer export requires successful non-null reads and preserves signed offsets', () => {
  const { catalog, run } = fixture({ items: [{
    id: 'root', name: 'Pointer root', module: 'Fixture.exe', kind: 'pointer', rva: '0x80',
    pointerSize: 8, offsets: ['-0x10', '0x20'], addend: '-0x8', checks: [],
  }] });
  const code = generateAngelScript(catalog, run, ['root']);
  assert.match(code, /read_uint64\(candidate, pointer_0\) \|\| pointer_0 == 0/);
  assert.match(code, /sd_add\(uint64\(pointer_0\), uint64\(0x10\), true, candidate\)/);
  assert.match(code, /sd_add\(candidate, uint64\(0x8\), true, candidate\)/);
});

test('all validation variants survive export and uint64 limits stay exact', () => {
  const { catalog, run } = fixture({ items: [{
    id: 'data', name: 'Structured data', module: 'Fixture.exe', kind: 'rva', rva: '0x100',
    checks: [
      { type: 'bytes', pattern: '48 ?? 8B' },
      { type: 'in_module', module: 'Fixture.exe' },
      { type: 'range', dataType: 'u64', min: '0', max: '18446744073709551615' },
      { type: 'range', dataType: 'i64', min: '-9223372036854775808', max: '9223372036854775807' },
      { type: 'range', dataType: 'f32', min: '-1.5', max: '9.25' },
    ],
  }] });
  const code = generateAngelScript(catalog, run, ['data']);
  assert.match(code, /bytes_0\[0\] != 0x48/);
  assert.match(code, /bytes_0\[2\] != 0x8B/);
  assert.doesNotMatch(code, /bytes_0\[1\] !=/);
  assert.match(code, /candidate - check_base_1 >= check_size_1/);
  assert.match(code, /value_2 <= uint64\(0xffffffffffffffff\)/);
  assert.match(code, /\(-int64\(0x7fffffffffffffff\) - 1\)/);
  assert.match(code, /value_4 != value_4/);
  assert.match(code, /double\(value_4\) >= -1.5 && double\(value_4\) <= 9.25/);
});

test('identifiers cannot collide after sanitization', () => {
  const { catalog, run } = fixture({ items: [
    { id: 'a-b', name: 'One', kind: 'rva', module: 'Fixture.exe', rva: '0x20', checks: [] },
    { id: 'a_b', name: 'Two', kind: 'rva', module: 'Fixture.exe', rva: '0x28', checks: [] },
  ] });
  const code = generateAngelScript(catalog, run, ['a-b', 'a_b']);
  assert.match(code, /bool sd_a_b_resolve/);
  assert.match(code, /bool sd_a_b_2_resolve/);
});

test('identifiers cannot shadow generated helper functions or other resolvers', () => {
  const { catalog, run } = fixture({ items: [
    { id: 'readable', name: 'Readable item', kind: 'rva', module: 'Fixture.exe', rva: '0x20', checks: [] },
    { id: 'x', name: 'X', kind: 'rva', module: 'Fixture.exe', rva: '0x28', checks: [] },
    { id: 'x_resolve', name: 'X resolver', kind: 'rva', module: 'Fixture.exe', rva: '0x30', checks: [] },
  ] });
  const code = generateAngelScript(catalog, run, ['readable', 'x', 'x_resolve']);
  assert.match(code, /uint64 sd_readable_2 = 0;/);
  assert.match(code, /uint64 sd_x_resolve_2 = 0;/);
});

test('malformed completed reports cannot bypass the export gate', () => {
  const { catalog, run } = fixture();
  const incomplete = { ...run, completedAt: '' };
  assert.throws(() => createManifest(catalog, incomplete, ['count']), /incomplete/);
  const duplicate = { ...run, results: [...run.results, run.results[0]] };
  assert.throws(() => createManifest(catalog, duplicate, ['count']), /duplicate/);
  run.results[0].address = '0x0';
  assert.throws(() => createManifest(catalog, run, ['camera-root']), /usable resolved/);
});

test('empty or truthy nonboolean validation evidence cannot pass the review gate', () => {
  for (const checks of [[], [{ passed: 'true' }], [null]]) {
    const { catalog, run } = fixture();
    run.results[0].checks = checks;
    assert.throws(() => createManifest(catalog, run, ['camera-root']), /failed validation/);
  }
});

test('generated scripts use only the documented shared process binding subset', () => {
  const { catalog, run } = fixture();
  const code = generateAngelScript(catalog, run, ['camera-root', 'count']);
  assert.match(code, /portable AngelScript runtime resolvers/);
  assert.doesNotMatch(code, /Echo|Ech0|Solanius|process::open_socket|virtual_query|ui::|ws::|atomic_/);
  const allowed = new Set(['attach', 'is_alive', 'get_module_base', 'get_module_size', 'find_signatures', 'get_relative_address', 'read_bytes', 'read_int8', 'read_uint8', 'read_int16', 'read_uint16', 'read_int32', 'read_uint32', 'read_int64', 'read_uint64', 'read_float', 'read_double']);
  for (const match of code.matchAll(/process::([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) assert.ok(allowed.has(match[1]), `Unexpected binding ${match[1]}`);
  assert.match(code, /process::attach\(SD_PROCESS\)/); // One arg works with a host's optional second arg.
});
