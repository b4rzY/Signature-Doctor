#!/usr/bin/env node
// Optional real-VM checks. The SDK and native compiler are not runtime app dependencies.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { validateCatalog, hashCatalog, hashItem } from '../shared/catalog.mjs';
import { generateAngelScript } from '../shared/export.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const sdkArg = process.argv.indexOf('--sdk');
if (sdkArg >= 0 && (!process.argv[sdkArg + 1] || process.argv[sdkArg + 1].startsWith('--'))) throw new Error('--sdk requires a path to the SDK directory.');
const sdk = resolve(sdkArg >= 0 ? process.argv[sdkArg + 1] : process.env.ANGELSCRIPT_SDK ?? join(root, 'tmp/angelscript/angelscript-2.38.0/sdk'));
const header = join(sdk, 'angelscript/include/angelscript.h');
if (!existsSync(header)) throw new Error('Set ANGELSCRIPT_SDK or pass --sdk pointing to the sdk directory of official AngelScript 2.38.0. See tests/angelscript/README.md.');
if (!/ANGELSCRIPT_VERSION_STRING\s+"2\.38\.0"/.test(readFileSync(header, 'utf8'))) throw new Error('This reproducible fixture suite is pinned to AngelScript SDK 2.38.0.');
for (const path of ['tests/angelscript/runner.cpp', 'tests/angelscript/host-echo.as', 'tests/angelscript/host-solanius.as', 'tests/angelscript/process-stubs.as', 'tests/angelscript/connector-stubs.as', 'tests/angelscript/connector-assertions.as', 'examples/angelscript-connect.as']) {
  if (!existsSync(join(root, path))) throw new Error(`Required compiler fixture is missing: ${path}. Preserve the repository's directory structure.`);
}
const out = join(root, 'tmp/angelscript-check');
mkdirSync(out, { recursive: true });
const cxx = process.env.CXX || 'g++';
const includes = ['angelscript/include', 'add_on/scriptarray', 'add_on/scriptstdstring'].flatMap(path => ['-I', join(sdk, path)]);
const flags = ['-std=c++17', '-O0', '-DAS_MAX_PORTABILITY', '-pthread', ...includes];
const source = join(sdk, 'angelscript/source');
const sources = readdirSync(source).filter(name => name.endsWith('.cpp')).sort().map(name => join(source, name));
sources.push(join(sdk, 'add_on/scriptarray/scriptarray.cpp'), join(sdk, 'add_on/scriptstdstring/scriptstdstring.cpp'), join(root, 'tests/angelscript/runner.cpp'));
function execute(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', timeout: 120_000, cwd: out, env: { ...process.env, TMPDIR: out } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${basename(command)} failed with exit code ${result.status}`);
}
console.log('Preparing AngelScript 2.38.0 compiler and synthetic host fixtures…');
const objects = sources.map(path => {
  const object = join(out, `${basename(path)}.o`);
  if (!existsSync(object) || statSync(object).mtimeMs < statSync(path).mtimeMs || statSync(object).mtimeMs < statSync(header).mtimeMs) execute(cxx, [...flags, '-c', path, '-o', object]);
  return object;
});
const runner = join(out, process.platform === 'win32' ? 'runner.exe' : 'runner');
if (!existsSync(runner) || objects.some(path => statSync(path).mtimeMs > statSync(runner).mtimeMs)) execute(cxx, ['-pthread', ...objects, '-o', runner]);

function exportFixture(items) {
  const catalog = validateCatalog({ schemaVersion: 1, id: 'vm-fixture', name: 'Synthetic compiler fixture', processName: 'Fixture.exe', items });
  const run = { schemaVersion: 1, id: 'synthetic-vm-fixture', catalogId: catalog.id, catalogHash: hashCatalog(catalog), label: 'Synthetic API stubs', mode: 'live', completedAt: '2026-10-24T00:00:00.000Z', results: catalog.items.map(item => ({ id: item.id, status: 'valid', address: '0xfedcba9876540080', definitionHash: hashItem(item), checks: [{ label: 'Synthetic fixture input', passed: true, detail: 'This is a VM unit test, not a live process report.' }] })) };
  return generateAngelScript(catalog, run, catalog.items.map(item => item.id));
}
const types = [
  ['u8', '0x300', '255', '255', '0xff', 1], ['i8', '0x310', '-128', '-128', '0x80', 1],
  ['u16', '0x320', '65535', '65535', '0xffff', 2], ['i16', '0x330', '-32768', '-32768', '0x8000', 2],
  ['u32', '0x340', '4294967295', '4294967295', '0xffffffff', 4], ['i32', '0x350', '-2147483648', '-2147483648', '0x80000000', 4],
  ['u64', '0x360', '18446744073709551615', '18446744073709551615', '0xffffffffffffffff', 8],
  ['i64', '0x370', '-9223372036854775808', '-9223372036854775808', '0x8000000000000000', 8],
  ['f32', '0x380', '0', '1', '0x3dcccccd', 4], ['f64', '0x390', '0', '1', '0x3fb999999999999a', 8],
];
const items = [
  { id: 'relative', name: 'Relative bytes', kind: 'signature', module: 'Fixture.exe', pattern: '48 8B 05 ?? ?? ?? ??', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'bytes', pattern: 'AB CD ?? EF' }, { type: 'alignment', value: 16 }, { type: 'in_module', module: 'Fixture.exe' }] },
  { id: 'chain', name: 'Signed pointer chain', kind: 'pointer', module: 'Fixture.exe', rva: '0x200', offsets: ['-0x10', '0x20'], addend: '-0x8', pointerSize: 8, checks: [{ type: 'readable', size: 8 }] },
  ...types.map(([type, rva, min, max]) => ({ id: type, name: `${type} exact range`, kind: 'rva', module: 'Fixture.exe', rva, checks: [{ type: 'range', dataType: type, min, max }] })),
];
const setup = `void prepare_fixture() {
    fixture_reset();
    fixture_write(fixture_base + 0x103, uint64(0xffffff79), 4); // signed rel32 = -135
    fixture_write(fixture_base + 0x80, uint64(0xef00cdab), 4);
    fixture_write(fixture_base + 0x200, fixture_base + 0x10100, 8);
    fixture_write(fixture_base + 0x100f0, fixture_base + 0x10200, 8);
    ${types.map(([,rva,,,bits,size]) => `fixture_write(fixture_base + ${rva}, uint64(${bits}), ${size});`).join('\n    ')}
}`;
const assertions = `${setup}
bool test_main() {
    prepare_fixture();
    if (!main() || sd_relative != fixture_base + 0x80 || sd_chain != fixture_base + 0x10218) return false;
    uint64 value = 0;
    if (sd_add(uint64(0xffffffffffffffff), 1, false, value)) return false;
    if (sd_add(0, 1, true, value)) return false;
    value = 100; if (!sd_add(value, 1, false, value) || value != 101) return false;
    fixture_scan_count = 2; if (sd_resolve_all() || sd_relative != 0 || sd_chain != 0) return false;
    prepare_fixture(); fixture_relative_wrong = true; if (sd_resolve_all()) return false;
    prepare_fixture(); fixture_reads_succeed = false; if (sd_resolve_all()) return false;
    prepare_fixture(); fixture_short_reads = true; if (sd_resolve_all()) return false;
    prepare_fixture(); fixture_write(fixture_base + 0x360, uint64(0xfffffffffffffffe), 8); if (sd_resolve_all()) return false;
    prepare_fixture(); fixture_write(fixture_base + 0x380, uint64(0x7fc00000), 4); if (sd_resolve_all()) return false;
    return true;
}`;
const cases = [
  ['resolvers', exportFixture(items), assertions],
  ['pointer32', exportFixture([{ id: 'pointer32', name: '32-bit pointer', kind: 'pointer', module: 'Fixture.exe', rva: '0x200', offsets: ['-0x10'], pointerSize: 4, checks: [] }]), 'bool test_main() { fixture_reset(); fixture_base = 0x400000; fixture_write(fixture_base + 0x200, fixture_base + 0x500, 4); if (!main() || sd_pointer32 != 0x4004f0) return false; fixture_write(fixture_base + 0x200, 0, 4); return !sd_resolve_all() && sd_pointer32 == 0; }'],
  ['float-boundary', exportFixture([{ id: 'boundary', name: 'Exact float comparison', kind: 'rva', module: 'Fixture.exe', rva: '0x200', checks: [{ type: 'range', dataType: 'f32', min: '0.10000000149011613', max: '1' }] }]), 'bool test_main() { fixture_reset(); fixture_write(fixture_base + 0x200, 0x3dcccccd, 4); return !main() && sd_boundary == 0; }'],
];
let verified = 0;
for (const host of ['echo', 'solanius']) {
  const common = [join(root, `tests/angelscript/host-${host}.as`), join(root, 'tests/angelscript/process-stubs.as')];
  for (const [name, script, assertions] of cases) {
    const generated = join(out, `${name}.as`), test = join(out, `${name}-assertions.as`);
    writeFileSync(generated, script); writeFileSync(test, assertions);
    console.log(`\n${host}: generated ${name}`);
    execute(runner, [...common, generated, test]); verified++;
  }
  const connectorStubs = join(root, 'tests/angelscript/connector-stubs.as');
  const connectorAssertions = join(root, 'tests/angelscript/connector-assertions.as');
  console.log(`\n${host}: portable connector dispatch`);
  execute(runner, [...common, connectorStubs, join(root, 'examples/angelscript-connect.as'), connectorAssertions]); verified++;
}
console.log(`\n${verified} real AngelScript compiler/VM fixture runs passed. Host behavior is synthetic; live Echo and Solanius validation remains a separate check.`);
