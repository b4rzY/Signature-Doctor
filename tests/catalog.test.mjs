import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { validateCatalog, parseAddress, parseOffset, hex, normalizePattern, hashItem, hashCatalog } from '../shared/catalog.mjs';
import { DEMO_CATALOG } from '../shared/demo.mjs';

const copy = value => JSON.parse(JSON.stringify(value));
test('normalization is idempotent and preserves a portable JSON-only catalog', () => {
  const c = validateCatalog(copy(DEMO_CATALOG));
  assert.deepEqual(validateCatalog(c), c);
  assert.equal(c.items[0].enabled, true);
  assert.equal(c.items[0].addend, '0x0');
  assert.equal(c.items[5].pointerSize, 8);
});
test('addresses retain all 64 bits and reject unsafe numeric JSON inputs', () => {
  assert.equal(hex(parseAddress('0xfedcba9876543210')), '0xfedcba9876543210');
  assert.equal(parseAddress('18446744073709551615'), 0xffffffffffffffffn);
  for (const value of [42, Number.MAX_SAFE_INTEGER + 1, '0x10000000000000000', '-1', '1e3', '0x', '12junk', null]) assert.throws(() => parseAddress(value));
  assert.equal(hex(parseOffset('-0x20')), '-0x20');
  assert.equal(parseOffset('-9223372036854775808'), -(1n << 63n));
  assert.throws(() => parseOffset('9223372036854775808'));
});
test('patterns normalize whole-byte wildcards and reject unbounded or malformed scans', () => {
  assert.equal(normalizePattern('48 8b ? ?? 0f'), '48 8B ?? ?? 0F');
  for (const value of ['?? ??', '48 8?', '', 'GG 02', 'AA '.repeat(257)]) assert.throws(() => normalizePattern(value));
});
test('catalog validation rejects duplicate IDs, duplicate names and unknown schemas', () => {
  for (const mutate of [
    c => { c.schemaVersion = 2; },
    c => { c.items[1].id = c.items[0].id; },
    c => { c.items[1].name = c.items[0].name.toLowerCase(); },
    c => { c.items[0].kind = 'arbitrary_script'; },
    c => { c.processName = '../Asterion.exe'; },
    c => { c.items[0].enabled = 'false'; },
  ]) { const c = copy(DEMO_CATALOG); mutate(c); assert.throws(() => validateCatalog(c)); }
});
test('unknown import fields are rejected so typos cannot silently remove validation', () => {
  for (const mutate of [
    c => { c.version = 1; },
    c => { c.items[0].check = c.items[0].checks; delete c.items[0].checks; },
    c => { c.items[0].enable = false; },
    c => { c.items[0].checks[0].sizes = 8; },
    c => { c.items[0].relative.instructionLength = 7; },
  ]) { const c = copy(DEMO_CATALOG); mutate(c); assert.throws(() => validateCatalog(c), /unknown field/); }
});
test('pointer chains, rel32 extraction and configured reads have enforced bounds', () => {
  for (const mutate of [
    c => { c.items[5].offsets = []; },
    c => { c.items[5].offsets = Array(13).fill('0'); },
    c => { c.items[5].pointerSize = 16; },
    c => { c.items[0].relative = { offset: 5, instructionSize: 7 }; },
    c => { c.items[4].relative = { offset: 3, instructionSize: 7 }; },
    c => { c.items[0].checks = [{ type: 'readable', size: 65537 }]; },
    c => { c.items[0].checks = [{ type: 'alignment', value: 3 }]; },
    c => { c.items[0].checks = [{ type: 'execute' }]; },
  ]) { const c = copy(DEMO_CATALOG); mutate(c); assert.throws(() => validateCatalog(c)); }
});
test('numeric validators preserve large integers and reject NaN, out-of-range and reversed bounds', () => {
  const c = copy(DEMO_CATALOG);
  c.items[0].checks = [{ type: 'range', dataType: 'u64', min: '0x20000000000001', max: '18446744073709551615' }];
  assert.equal(validateCatalog(c).items[0].checks[0].min, '9007199254740993');
  for (const check of [
    { type: 'range', dataType: 'u8', min: '-1', max: '255' },
    { type: 'range', dataType: 'i8', min: '-128', max: '128' },
    { type: 'range', dataType: 'f32', min: 'NaN', max: '1' },
    { type: 'range', dataType: 'f64', min: '0', max: 'Infinity' },
    { type: 'range', dataType: 'u32', min: '2', max: '1' },
    { type: 'range', dataType: 'f32', min: '0', max: '1e40' },
    { type: 'range', dataType: 'u32', min: 0, max: 1 },
  ]) { c.items[0].checks = [check]; assert.throws(() => validateCatalog(c)); }
});
test('definition fingerprints use standard SHA-256 and change when validation changes', () => {
  const normalized = validateCatalog(DEMO_CATALOG);
  assert.equal(hashCatalog(normalized), createHash('sha256').update(JSON.stringify(normalized)).digest('hex'));
  const { name, notes, ...definition } = normalized.items[0];
  assert.equal(hashItem(normalized.items[0]), createHash('sha256').update(JSON.stringify(definition)).digest('hex'));
  const item = copy(normalized.items[0]);
  item.notes = 'A note does not change resolution semantics';
  assert.equal(hashItem(item), hashItem(normalized.items[0]));
  item.checks.push({ type: 'alignment', value: 16 });
  assert.notEqual(hashItem(item), hashItem(normalized.items[0]));
});
