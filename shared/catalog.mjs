/** Strict, dependency-free catalog parsing shared by the browser and exporters. */
export const U64_MAX = (1n << 64n) - 1n;
const I64_MIN = -(1n << 63n);
const I64_MAX = (1n << 63n) - 1n;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const INTEGER = /^-?(?:0x[0-9a-f]+|[0-9]+)$/i;
const FLOAT = /^-?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i;

function fail(label, message) { throw new Error(`${label}: ${message}`); }
function object(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label, 'expected an object');
  return value;
}
function keys(value, allowed, label) {
  const unexpected = Object.keys(value).filter(key => !allowed.includes(key));
  if (unexpected.length) fail(label, `unknown field${unexpected.length === 1 ? '' : 's'}: ${unexpected.join(', ')}`);
}
function text(value, label, max = 128) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || CONTROL.test(value)) fail(label, `expected 1–${max} characters without control characters`);
  return value.trim();
}
function id(value, label) { const s = text(value, label, 64); if (!ID.test(s)) fail(label, 'use letters, numbers, dots, underscores, or hyphens'); return s; }
function filename(value, label) {
  const s = text(value, label, 128);
  if (/[\\/<>:"|?*]/.test(s) || s === '.' || s === '..') fail(label, 'expected a module filename, not a path');
  return s;
}
function integer(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(label, `expected an integer from ${min} to ${max}`);
  return value;
}
function integerString(value, label) {
  if (typeof value !== 'string' || value.length > 80 || !INTEGER.test(value.trim())) fail(label, 'expected a decimal or 0x-prefixed hexadecimal string');
  const s = value.trim();
  return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s);
}
/** Parse an unsigned 64-bit address. Numbers are deliberately rejected to prevent lost precision. */
export function parseAddress(value, label = 'Address') {
  const n = typeof value === 'bigint' ? value : integerString(value, label);
  if (n < 0n || n > U64_MAX) fail(label, 'outside the unsigned 64-bit range');
  return n;
}
/** Signed offsets accept decimal and hexadecimal strings, including -0x20. */
export function parseOffset(value, label = 'Offset') {
  const n = typeof value === 'bigint' ? value : integerString(value, label);
  if (n < I64_MIN || n > I64_MAX) fail(label, 'outside the signed 64-bit range');
  return n;
}
export function hex(value) {
  const n = typeof value === 'bigint' ? value : BigInt(value);
  return n < 0n ? `-0x${(-n).toString(16)}` : `0x${n.toString(16)}`;
}
export function normalizePattern(value, label = 'Pattern') {
  const s = text(value, label, 1024);
  const tokens = s.split(/\s+/);
  if (tokens.length > 256 || tokens.some(t => !/^(?:[0-9a-f]{2}|\?\??)$/i.test(t))) fail(label, 'use at most 256 complete byte pairs or ? / ?? wildcards');
  if (tokens.every(t => t.startsWith('?'))) fail(label, 'at least one concrete byte is required');
  return tokens.map(t => t.startsWith('?') ? '??' : t.toUpperCase()).join(' ');
}
export function patternBytes(pattern) { return normalizePattern(pattern).split(' ').map(v => v === '??' ? null : Number.parseInt(v, 16)); }

export const DATA_TYPES = Object.freeze({
  u8: { size: 1, signed: false }, i8: { size: 1, signed: true },
  u16: { size: 2, signed: false }, i16: { size: 2, signed: true },
  u32: { size: 4, signed: false }, i32: { size: 4, signed: true },
  u64: { size: 8, signed: false }, i64: { size: 8, signed: true },
  f32: { size: 4, float: true }, f64: { size: 8, float: true },
});
function rangeBound(value, dataType, label) {
  const type = DATA_TYPES[dataType];
  if (type.float) {
    if (typeof value !== 'string' || value.length > 80 || !FLOAT.test(value.trim()) || !Number.isFinite(Number(value))) fail(label, 'expected a finite numeric string');
    const n = Number(value);
    if (dataType === 'f32' && Math.abs(n) > 3.4028234663852886e38) fail(label, 'outside float32 range');
    return String(n);
  }
  const n = integerString(value, label);
  const bits = BigInt(type.size * 8);
  const low = type.signed ? -(1n << (bits - 1n)) : 0n;
  const high = type.signed ? (1n << (bits - 1n)) - 1n : (1n << bits) - 1n;
  if (n < low || n > high) fail(label, `outside ${dataType} range`);
  return n.toString();
}
function check(value, label) {
  const c = object(value, label);
  const allowed = {
    readable: ['type', 'size'], bytes: ['type', 'pattern'],
    range: ['type', 'dataType', 'min', 'max'], in_module: ['type', 'module'], alignment: ['type', 'value'],
  };
  if (Object.hasOwn(allowed, c.type)) keys(c, allowed[c.type], label);
  switch (c.type) {
    case 'readable': return { type: c.type, size: integer(c.size, 1, 65536, `${label}.size`) };
    case 'bytes': return { type: c.type, pattern: normalizePattern(c.pattern, `${label}.pattern`) };
    case 'range': {
      if (!Object.hasOwn(DATA_TYPES, c.dataType)) fail(label, 'unknown numeric data type');
      const min = rangeBound(c.min, c.dataType, `${label}.min`);
      const max = rangeBound(c.max, c.dataType, `${label}.max`);
      const parse = DATA_TYPES[c.dataType].float ? Number : BigInt;
      if (parse(min) > parse(max)) fail(label, 'minimum must not exceed maximum');
      return { type: c.type, dataType: c.dataType, min, max };
    }
    case 'in_module': return { type: c.type, module: filename(c.module, `${label}.module`) };
    case 'alignment': {
      const value = integer(c.value, 1, 65536, `${label}.value`);
      if ((value & (value - 1)) !== 0) fail(label, 'alignment must be a power of two');
      return { type: c.type, value };
    }
    default: fail(label, `unknown check type ${String(c.type)}`);
  }
}
export function validateCatalog(input) {
  const catalog = object(input, 'Catalog');
  keys(catalog, ['schemaVersion', 'id', 'name', 'processName', 'items'], 'Catalog');
  if (catalog.schemaVersion !== 1) fail('Catalog', 'unsupported schemaVersion; expected 1');
  if (!Array.isArray(catalog.items) || catalog.items.length > 250) fail('Catalog.items', 'expected an array of at most 250 items');
  const ids = new Set();
  const names = new Set();
  const items = catalog.items.map((inputItem, index) => {
    const label = `Item ${index + 1}`;
    const item = object(inputItem, label);
    keys(item, ['id', 'name', 'module', 'kind', 'pattern', 'rva', 'relative', 'addend', 'offsets', 'pointerSize', 'checks', 'notes', 'enabled'], label);
    const out = { id: id(item.id, `${label}.id`), name: text(item.name, `${label}.name`, 96), module: filename(item.module, `${label}.module`), kind: item.kind };
    if (ids.has(out.id)) fail(label, `duplicate ID ${out.id}`);
    if (names.has(out.name.toLowerCase())) fail(label, `duplicate name ${out.name}`);
    ids.add(out.id); names.add(out.name.toLowerCase());
    if (!['signature', 'rva', 'pointer'].includes(item.kind)) fail(label, 'kind must be signature, rva, or pointer');
    if (item.kind === 'signature') {
      out.pattern = normalizePattern(item.pattern, `${label}.pattern`);
      if (item.relative !== undefined) {
        const r = object(item.relative, `${label}.relative`);
        keys(r, ['offset', 'instructionSize'], `${label}.relative`);
        out.relative = { offset: integer(r.offset, 0, 60, `${label}.relative.offset`), instructionSize: integer(r.instructionSize, 1, 64, `${label}.relative.instructionSize`) };
        if (out.relative.offset + 4 > out.relative.instructionSize) fail(`${label}.relative`, 'the four-byte displacement must fit inside the instruction');
      }
    } else {
      if (item.relative !== undefined) fail(label, 'relative resolution is supported for signatures only');
      out.rva = hex(parseAddress(item.rva, `${label}.rva`));
    }
    out.addend = hex(parseOffset(item.addend ?? '0x0', `${label}.addend`));
    if (item.kind === 'pointer') {
      if (!Array.isArray(item.offsets) || item.offsets.length < 1 || item.offsets.length > 12) fail(`${label}.offsets`, 'expected 1–12 pointer-chain offsets');
      out.offsets = item.offsets.map((v, i) => hex(parseOffset(v, `${label}.offsets[${i}]`)));
      out.pointerSize = item.pointerSize ?? 8;
      if (![4, 8].includes(out.pointerSize)) fail(`${label}.pointerSize`, 'expected 4 or 8');
    }
    const checks = item.checks ?? [];
    if (!Array.isArray(checks) || checks.length > 16) fail(`${label}.checks`, 'expected at most 16 checks');
    out.checks = checks.map((v, i) => check(v, `${label}.checks[${i}]`));
    if (item.notes !== undefined) {
      if (typeof item.notes !== 'string' || item.notes.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(item.notes)) fail(`${label}.notes`, 'expected at most 4000 text characters');
      out.notes = item.notes;
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') fail(`${label}.enabled`, 'expected a boolean');
    out.enabled = item.enabled ?? true;
    return out;
  });
  return { schemaVersion: 1, id: id(catalog.id, 'Catalog.id'), name: text(catalog.name, 'Catalog.name', 96), processName: filename(catalog.processName, 'Catalog.processName'), items };
}

// Synchronous SHA-256 keeps fingerprints identical in browsers and Node without dependencies.
// Fingerprints identify definitions; they do not authenticate imported data or its author.
function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const length = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(length); padded.set(bytes); padded[bytes.length] = 128;
  const view = new DataView(padded.buffer);
  view.setUint32(length - 8, Math.floor(bytes.length / 0x20000000), false);
  view.setUint32(length - 4, bytes.length * 8 >>> 0, false);
  const h = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  const w = new Uint32Array(64);
  for (let p = 0; p < length; p += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(p + i * 4, false);
    for (let i = 16; i < 64; i++) { const x = w[i - 15], y = w[i - 2]; w[i] = (w[i - 16] + (rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3)) + w[i - 7] + (rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10))) >>> 0; }
    let [a,b,c,d,e,f,g,z] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (z + (rotr(e,6)^rotr(e,11)^rotr(e,25)) + ((e&f)^(~e&g)) + k[i] + w[i]) >>> 0;
      const t2 = ((rotr(a,2)^rotr(a,13)^rotr(a,22)) + ((a&b)^(a&c)^(b&c))) >>> 0;
      z=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    [a,b,c,d,e,f,g,z].forEach((v,i) => h[i]=(h[i]+v)>>>0);
  }
  return h.map(x => x.toString(16).padStart(8, '0')).join('');
}
export function hashItem(item) {
  const normalized = validateCatalog({ schemaVersion: 1, id: 'fingerprint', name: 'Fingerprint', processName: 'fingerprint.exe', items: [item] }).items[0];
  const { name, notes, ...definition } = normalized;
  return sha256(JSON.stringify(definition));
}
export function hashCatalog(catalog) { return sha256(JSON.stringify(validateCatalog(catalog))); }
