import { validateCatalog, parseAddress, parseOffset, hex, patternBytes, DATA_TYPES, hashItem, hashCatalog, U64_MAX } from './catalog.mjs';

class ResolutionError extends Error { constructor(status, message) { super(message); this.status = status; } }
const lower = s => s.toLowerCase();
const now = () => globalThis.performance?.now?.() ?? Date.now();
function aborted(signal) { if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new DOMException('Check cancelled', 'AbortError'); }
function nonzero(address, label) { const n = parseAddress(address, label); if (!n) throw new ResolutionError('invalid', `${label} is null`); return n; }
function add(address, offset, label = 'Resolved address') { const value = address + offset; if (value < 0n || value > U64_MAX) throw new ResolutionError('invalid', `${label} overflowed the 64-bit address range`); return value; }
function contains(module, address, size = 1) { const base = parseAddress(module.base); return address >= base && address + BigInt(size) <= base + BigInt(module.size); }
function findModule(modules, name) { return modules.find(m => lower(m.name) === lower(name)); }
function location(modules, address) { const m = modules.find(m => contains(m, address)); return m ? { module: m.name, rva: hex(address - parseAddress(m.base)) } : {}; }
function id() { return globalThis.crypto?.randomUUID?.() ?? `run-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
async function call(rpc, request, signal) {
  aborted(signal);
  const response = await rpc(request, signal);
  aborted(signal);
  if (!response || typeof response !== 'object' || Array.isArray(response)) throw new ResolutionError('error', 'The agent returned a malformed response');
  if (response.type === 'error') throw new ResolutionError('error', `${response.message || 'Agent error'}${response.detail ? `: ${response.detail}` : ''}`);
  const expected = `${request.type}_result`;
  if (response.type !== expected) throw new ResolutionError('error', `Expected ${expected}; received ${String(response.type)}`);
  return response;
}
async function read(rpc, address, size, signal) {
  if (address < 0n || address > U64_MAX || address + BigInt(size) - 1n > U64_MAX) throw new ResolutionError('invalid', 'Read crosses the 64-bit address boundary');
  const response = await call(rpc, { type: 'read', address: hex(address), size }, signal);
  if (response.success !== true || typeof response.data !== 'string' || response.data.length !== size * 2 || !/^[0-9a-f]+$/i.test(response.data)) throw new ResolutionError('error', `Could not read ${size} byte${size === 1 ? '' : 's'} at ${hex(address)}`);
  if (response.address !== undefined && parseAddress(response.address, 'Read response address') !== address) throw new ResolutionError('error', 'Read response address does not match the requested address');
  if (response.size !== undefined && response.size !== size) throw new ResolutionError('error', 'Read response size does not match the requested size');
  return Uint8Array.from(response.data.match(/.{2}/g), v => Number.parseInt(v, 16));
}
function decode(bytes, dataType) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  switch (dataType) {
    case 'u8': return BigInt(v.getUint8(0)); case 'i8': return BigInt(v.getInt8(0));
    case 'u16': return BigInt(v.getUint16(0, true)); case 'i16': return BigInt(v.getInt16(0, true));
    case 'u32': return BigInt(v.getUint32(0, true)); case 'i32': return BigInt(v.getInt32(0, true));
    case 'u64': return v.getBigUint64(0, true); case 'i64': return v.getBigInt64(0, true);
    case 'f32': return v.getFloat32(0, true); case 'f64': return v.getFloat64(0, true);
  }
}
async function identity(rpc, catalog, signal) {
  const ping = await call(rpc, { type: 'ping' }, signal);
  if (ping.attached !== true || !Number.isSafeInteger(ping.pid) || ping.pid <= 0) throw new Error('No running target process is attached');
  const base = hex(nonzero(ping.base, 'Process base'));
  const response = await call(rpc, { type: 'modules' }, signal);
  if (response.success !== true || !Array.isArray(response.modules) || !response.modules.length || response.modules.length > 4096) throw new Error('Could not enumerate target modules');
  const names = new Set();
  const modules = response.modules.map(m => {
    if (!m || typeof m.name !== 'string' || !m.name || m.name.length > 512 || !Number.isSafeInteger(m.size) || m.size <= 0) throw new Error('The agent returned malformed module metadata');
    const moduleBase = nonzero(m.base, `Module ${m.name} base`);
    if (moduleBase + BigInt(m.size) - 1n > U64_MAX) throw new Error('Module extends beyond the 64-bit address space');
    if (names.has(lower(m.name))) throw new Error(`Duplicate module name ${m.name}; cannot resolve it unambiguously`);
    names.add(lower(m.name));
    return { name: m.name, base: hex(moduleBase), size: m.size };
  }).sort((a, b) => lower(a.name).localeCompare(lower(b.name)));
  const main = modules.find(m => m.base === base);
  if (!main || lower(main.name) !== lower(catalog.processName)) throw new Error(`Expected ${catalog.processName}; attached target reports ${main?.name || 'an unknown main module'}`);
  return { pid: ping.pid, base, modules };
}
async function validate(check, address, modules, rpc, signal) {
  switch (check.type) {
    case 'readable': {
      await read(rpc, address, check.size, signal);
      return { label: `Readable · ${check.size} bytes`, passed: true, detail: `Read succeeded at ${hex(address)}` };
    }
    case 'bytes': {
      const pattern = patternBytes(check.pattern);
      const data = await read(rpc, address, pattern.length, signal);
      const passed = pattern.every((b, i) => b === null || data[i] === b);
      return { label: 'Expected bytes', passed, detail: passed ? `Matches ${check.pattern}` : `Expected ${check.pattern}; observed ${Array.from(data, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ')}` };
    }
    case 'range': {
      const type = DATA_TYPES[check.dataType];
      const value = decode(await read(rpc, address, type.size, signal), check.dataType);
      const parse = type.float ? Number : BigInt;
      const passed = (!type.float || Number.isFinite(value)) && value >= parse(check.min) && value <= parse(check.max);
      return { label: `${check.dataType} range`, passed, detail: `Observed ${String(value)}; expected ${check.min}–${check.max}` };
    }
    case 'in_module': {
      const m = findModule(modules, check.module);
      const passed = !!m && contains(m, address);
      return { label: `Inside ${check.module}`, passed, detail: !m ? `Module ${check.module} is not loaded` : passed ? `${hex(address)} is inside the module` : `${hex(address)} is outside the module` };
    }
    case 'alignment': {
      const passed = address % BigInt(check.value) === 0n;
      return { label: `${check.value}-byte alignment`, passed, detail: passed ? 'Address is aligned' : `Address ${hex(address)} is not aligned` };
    }
  }
}
async function resolveItem(item, modules, rpc, previous, signal) {
  const started = now();
  const result = { id: item.id, status: 'valid', message: '', checks: [], trace: [], durationMs: 0, definitionHash: hashItem(item), comparison: 'new' };
  if (!item.enabled) return { ...result, status: 'disabled', message: 'Excluded from this build check' };
  try {
    const module = findModule(modules, item.module);
    if (!module) throw new ResolutionError('missing', `Module ${item.module} is not loaded`);
    const moduleBase = parseAddress(module.base);
    result.trace.push({ label: 'Module', value: `${module.name} @ ${module.base}` });
    let address;
    if (item.kind === 'signature') {
      const scan = await call(rpc, { type: 'sig_scan_ida', module: item.module, pattern: item.pattern, find_all: true }, signal);
      if (!Array.isArray(scan.results)) throw new ResolutionError('error', 'The signature scan returned malformed results');
      if (!scan.results.length) {
        if (scan.success !== false && scan.success !== true) throw new ResolutionError('error', 'The signature scan returned no success state');
        throw new ResolutionError('missing', 'No signature matches in the expected module');
      }
      if (scan.success !== true) throw new ResolutionError('error', 'The signature scan failed');
      const hits = [...new Set(scan.results.slice(0, 4096).map(x => hex(nonzero(x, 'Signature match'))))];
      const bytes = patternBytes(item.pattern).length;
      if (hits.some(hit => !contains(module, parseAddress(hit), bytes))) throw new ResolutionError('error', 'A signature result is outside the expected module');
      if (hits.length !== 1 || scan.results.length > 4096) {
        result.candidates = hits.slice(0, 32);
        result.candidateCount = scan.results.length > 4096 ? scan.results.length : hits.length;
        throw new ResolutionError('ambiguous', `${result.candidateCount} matches; narrow the pattern before accepting a result`);
      }
      address = parseAddress(hits[0]);
      result.sourceModule = module.name;
      result.sourceRva = hex(address - moduleBase);
      result.trace.push({ label: 'Unique signature', value: `${module.name}+${result.sourceRva}` });
      if (item.relative) {
        const instructionAddress = address;
        const displacement = decode(await read(rpc, add(address, BigInt(item.relative.offset)), 4, signal), 'i32');
        const expectedAddress = nonzero(add(address, BigInt(item.relative.instructionSize) + displacement), 'Relative target');
        const rel = await call(rpc, { type: 'resolve_relative', address: hex(address), offset: item.relative.offset, inst_size: item.relative.instructionSize }, signal);
        if (rel.success !== true) throw new ResolutionError('error', 'Relative-address resolution failed');
        address = nonzero(rel.address, 'Relative target');
        if (address !== expectedAddress) throw new ResolutionError('error', `Relative target disagrees with signed rel32 bytes at ${hex(instructionAddress)}`);
        result.trace.push({ label: 'Relative target', value: hex(address) });
      }
    } else {
      const rva = parseAddress(item.rva);
      if (rva >= BigInt(module.size)) throw new ResolutionError('invalid', `RVA ${item.rva} is outside ${module.name}`);
      address = add(moduleBase, rva);
      result.sourceModule = module.name; result.sourceRva = item.rva;
      result.trace.push({ label: 'Module-relative root', value: `${module.name}+${item.rva}` });
      if (item.kind === 'pointer') {
        for (let i = 0; i < item.offsets.length; i++) {
          const data = await read(rpc, address, item.pointerSize, signal);
          const pointer = nonzero(decode(data, item.pointerSize === 4 ? 'u32' : 'u64'), `Pointer at hop ${i + 1}`);
          address = nonzero(add(pointer, parseOffset(item.offsets[i])), `Address at hop ${i + 1}`);
          result.trace.push({ label: `Pointer hop ${i + 1}`, value: `${hex(pointer)} + ${item.offsets[i]} → ${hex(address)}` });
        }
      }
    }
    address = nonzero(add(address, parseOffset(item.addend)), 'Resolved address');
    if (parseOffset(item.addend)) result.trace.push({ label: 'Final addend', value: `${item.addend} → ${hex(address)}` });
    result.address = hex(address);
    Object.assign(result, location(modules, address));
    const checks = item.checks.some(c => c.type === 'readable') ? item.checks : [{ type: 'readable', size: 1 }, ...item.checks];
    let readError = false;
    for (const check of checks) {
      try { result.checks.push(await validate(check, address, modules, rpc, signal)); }
      catch (error) {
        aborted(signal);
        readError = true;
        result.checks.push({ label: check.type === 'readable' ? `Readable · ${check.size} bytes` : `${check.type} check`, passed: false, detail: error.message });
      }
    }
    if (readError) throw new ResolutionError('error', 'One or more validation reads failed; no result was accepted');
    if (result.checks.some(c => !c.passed)) throw new ResolutionError('invalid', 'Resolved successfully, but one or more checks failed');
    result.message = item.checks.length ? 'Resolved uniquely and passed every configured check' : 'Resolved and readable; no semantic checks configured';
    if (previous && previous.definitionHash !== result.definitionHash) {
      result.comparison = 'definition_changed';
      result.message += '. Definition changed; previous result was not used';
    } else if (previous && ['valid', 'moved'].includes(previous.status)) {
      const sourceMoved = previous.sourceModule && previous.sourceRva && (lower(previous.sourceModule) !== lower(result.sourceModule) || previous.sourceRva !== result.sourceRva);
      const destinationMoved = previous.module && previous.rva && result.module && result.rva && (lower(previous.module) !== lower(result.module) || previous.rva !== result.rva);
      const locationChanged = Boolean(previous.module) !== Boolean(result.module);
      if (sourceMoved || destinationMoved || locationChanged) {
        result.status = 'moved'; result.comparison = 'moved';
        result.previousRva = previous.rva;
        result.previousSourceRva = previous.sourceRva;
        result.message = sourceMoved && !destinationMoved ? 'Signature location moved; resolved value passed all checks' : 'Module-relative resolution changed; review before exporting';
      } else {
        result.comparison = result.module ? 'unchanged' : 'dynamic';
        result.message = result.module ? 'Matches the accepted baseline and passed every check' : 'Pointer root is stable; dynamic address passed every check';
      }
    }
  } catch (error) {
    aborted(signal);
    result.status = error.status || 'error';
    result.message = error.message || 'Unexpected resolution error';
  }
  result.durationMs = Math.round((now() - started) * 100) / 100;
  return result;
}

/** A run is returned only when every operation completes and the target identity stays stable. */
export async function checkBuild(input, { rpc, baseline, mode = 'live', label = 'Untitled build', signal, onProgress } = {}) {
  const catalog = validateCatalog(input);
  if (typeof rpc !== 'function') throw new Error('An RPC transport is required');
  if (!['demo', 'live'].includes(mode)) throw new Error('Run mode must be demo or live');
  if (typeof label !== 'string' || !label.trim() || label.length > 120 || /[\u0000-\u001f]/.test(label)) throw new Error('Build label must contain 1–120 printable characters');
  if (baseline && (baseline.schemaVersion !== 1 || baseline.catalogId !== catalog.id || baseline.mode !== mode || !Array.isArray(baseline.results))) throw new Error('The baseline belongs to a different catalog or connection mode');
  const startedAt = new Date().toISOString();
  const target = await identity(rpc, catalog, signal);
  const results = [];
  for (const item of catalog.items) {
    aborted(signal);
    const previous = baseline?.results.find(r => r.id === item.id);
    const result = await resolveItem(item, target.modules, rpc, previous, signal);
    results.push(result);
    onProgress?.({ completed: results.length, total: catalog.items.length, item, result });
  }
  const after = await identity(rpc, catalog, signal);
  if (JSON.stringify(target) !== JSON.stringify(after)) throw new Error('Target changed during the check. Results were discarded; attach the intended process and run again');
  aborted(signal);
  return { schemaVersion: 1, id: id(), catalogId: catalog.id, catalogHash: hashCatalog(catalog), label: label.trim(), mode, startedAt, completedAt: new Date().toISOString(), target, results, ...(baseline ? { baselineId: baseline.id } : {}) };
}
