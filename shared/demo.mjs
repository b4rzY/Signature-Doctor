import { validateCatalog, parseAddress, hex, patternBytes } from './catalog.mjs';
import { checkBuild } from './engine.mjs';

/** Entirely fictional fixture. No demo request reaches a local process or network. */
export const DEMO_CATALOG = validateCatalog({
  schemaVersion: 1, id: 'asterion-demo', name: 'Asterion · core signatures', processName: 'Asterion.exe',
  items: [
    { id: 'world-state', name: 'WorldState', module: 'Asterion.exe', kind: 'signature', pattern: '48 8B 05 ?? ?? ?? ?? 48 85 C0 74 0A', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'readable', size: 8 }, { type: 'in_module', module: 'Asterion.exe' }], notes: 'Global simulation state. RIP-relative load; validate the address of the global slot.' },
    { id: 'view-matrix', name: 'ViewMatrix', module: 'Asterion.exe', kind: 'signature', pattern: '48 8D 0D ?? ?? ?? ?? E8 ?? ?? ?? ?? 84 C0', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'readable', size: 64 }, { type: 'alignment', value: 16 }, { type: 'in_module', module: 'Asterion.exe' }], notes: 'This fixture relocates the camera matrix in the updated build. Review its new RVA before export.' },
    { id: 'entity-list', name: 'EntityList', module: 'Asterion.exe', kind: 'signature', pattern: '48 8B 0D ?? ?? ?? ?? 48 85 C9 74 07', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'readable', size: 8 }], notes: 'The update introduces a second matching instruction sequence. No candidate is chosen automatically.' },
    { id: 'settings-root', name: 'SettingsRoot', module: 'Asterion.exe', kind: 'signature', pattern: '48 8B 15 ?? ?? ?? ?? 33 C9 48 8B F8', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'readable', size: 8 }], notes: 'The old pattern disappears after the fictional update.' },
    { id: 'object-count', name: 'ObjectCount', module: 'Asterion.exe', kind: 'rva', rva: '0x31a020', checks: [{ type: 'range', dataType: 'u32', min: '0', max: '8192' }], notes: 'A readable address alone is insufficient. The updated value violates the expected range.' },
    { id: 'camera-chain', name: 'CameraState', module: 'Asterion.exe', kind: 'pointer', rva: '0x2fa000', offsets: ['0x20', '0x40'], pointerSize: 8, checks: [{ type: 'readable', size: 12 }, { type: 'range', dataType: 'f32', min: '0', max: '360' }], notes: 'Resolve *root + 0x20, then dereference and add 0x40. Heap allocation addresses may change between runs.' },
    { id: 'frame-delta', name: 'FrameDelta', module: 'engine.dll', kind: 'rva', rva: '0x18e020', checks: [{ type: 'range', dataType: 'f32', min: '0.0001', max: '1' }], notes: 'Seconds per simulation update, expected to remain finite and within range.' },
    { id: 'input-state', name: 'InputState', module: 'Asterion.exe', kind: 'signature', pattern: '0F B6 05 ?? ?? ?? ?? 84 C0 74 12', relative: { offset: 3, instructionSize: 7 }, checks: [{ type: 'range', dataType: 'u8', min: '0', max: '1' }], notes: 'A zero value is valid. Failed reads are reported separately.' },
    { id: 'experimental-cache', name: 'ExperimentalCache', module: 'engine.dll', kind: 'pointer', rva: '0x181000', offsets: ['0x28'], checks: [{ type: 'readable', size: 16 }], enabled: false, notes: 'Park an unfinished resolver without including it in health calculations.' },
  ],
});

function encode(value, type) {
  const size = { u8: 1, u32: 4, i32: 4, u64: 8, f32: 4 }[type];
  const bytes = new Uint8Array(size); const v = new DataView(bytes.buffer);
  if (type === 'u8') v.setUint8(0, Number(value));
  if (type === 'u32') v.setUint32(0, Number(value), true);
  if (type === 'i32') v.setInt32(0, Number(value), true);
  if (type === 'u64') v.setBigUint64(0, BigInt(value), true);
  if (type === 'f32') v.setFloat32(0, Number(value), true);
  return bytes;
}
function pause(ms, signal) {
  if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Cancelled', 'AbortError'));
  if (!ms) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason || new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

/** A bounded sparse-memory simulator implements Signature Doctor's read-only wire protocol. */
export function createDemoRpc(scenario = 'updated', { latencyMs = 16 } = {}) {
  if (!['baseline', 'updated'].includes(scenario)) throw new Error('Unknown demo scenario');
  const updated = scenario === 'updated';
  const base = updated ? 0x7ff600000000n : 0x140000000n;
  const engineBase = base + 0x800000n;
  const heap = updated ? 0x1d4a0000000n : 0x1b2c0000000n;
  const modules = [{ name: 'Asterion.exe', base: hex(base), size: 0x400000 }, { name: 'engine.dll', base: hex(engineBase), size: 0x200000 }];
  const memory = new Map();
  const put = (address, bytes) => bytes.forEach((byte, index) => memory.set(address + BigInt(index), byte));
  const get = (address, size) => {
    const result = [];
    for (let i = 0; i < size; i++) { const value = memory.get(address + BigInt(i)); if (value === undefined) return null; result.push(value); }
    return Uint8Array.from(result);
  };
  const instruction = (itemId, source, target) => {
    const item = DEMO_CATALOG.items.find(x => x.id === itemId);
    const bytes = Uint8Array.from(patternBytes(item.pattern), b => b ?? 0x90);
    if (item.relative) bytes.set(encode(target - (source + BigInt(item.relative.instructionSize)), 'i32'), item.relative.offset);
    put(source, bytes);
  };
  instruction('world-state', base + 0x1a2f0n, base + 0x2f8000n);
  put(base + 0x2f8000n, encode(heap, 'u64'));
  const cameraRva = updated ? 0x303c00n : 0x301800n;
  instruction('view-matrix', base + (updated ? 0x437c0n : 0x42a10n), base + cameraRva);
  const matrix = new Uint8Array(64);
  for (let i = 0; i < 4; i++) matrix.set(encode(1, 'f32'), i * 20);
  put(base + cameraRva, matrix);
  instruction('entity-list', base + 0x81230n, base + 0x310000n);
  if (updated) instruction('entity-list', base + 0x9c410n, base + 0x311000n);
  put(base + 0x310000n, encode(heap + 0x10000n, 'u64'));
  if (!updated) {
    instruction('settings-root', base + 0x2e100n, base + 0x318000n);
    put(base + 0x318000n, encode(heap + 0x20000n, 'u64'));
  }
  put(base + 0x31a020n, encode(updated ? 65535 : 124, 'u32'));
  put(base + 0x2fa000n, encode(heap + 0x40000n, 'u64'));
  put(heap + 0x40020n, encode(heap + 0x50000n, 'u64'));
  put(heap + 0x50040n, new Uint8Array(12));
  put(heap + 0x50040n, encode(90, 'f32'));
  put(engineBase + 0x18e020n, encode(1 / 60, 'f32'));
  instruction('input-state', base + 0x54b60n, base + 0x329e10n);
  put(base + 0x329e10n, encode(0, 'u8'));

  return async function demoRpc(request, signal) {
    await pause(latencyMs, signal);
    const reply = data => ({ id: request.id ?? 0, ...data });
    switch (request.type) {
      case 'ping': return reply({ type: 'ping_result', attached: true, pid: updated ? 18420 : 17904, base: hex(base) });
      case 'modules': return reply({ type: 'modules_result', success: true, modules: modules.map(m => ({ ...m })) });
      case 'read': {
        const bytes = get(parseAddress(request.address), request.size);
        return reply({ type: 'read_result', success: !!bytes, address: request.address, size: bytes ? bytes.length : 0, data: bytes ? Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('') : '' });
      }
      case 'sig_scan_ida': {
        const module = modules.find(m => m.name.toLowerCase() === String(request.module).toLowerCase());
        if (!module) return reply({ type: 'error', code: 1003, message: 'Module not found' });
        const start = parseAddress(module.base), end = start + BigInt(module.size), pattern = patternBytes(request.pattern);
        const results = [];
        for (const [address] of memory) {
          if (address < start || address + BigInt(pattern.length) > end) continue;
          const bytes = get(address, pattern.length);
          if (bytes && pattern.every((b, i) => b === null || bytes[i] === b)) results.push(hex(address));
        }
        return reply({ type: 'sig_scan_ida_result', success: results.length > 0, results: request.find_all ? results : results.slice(0, 1), module: request.module, pattern: request.pattern });
      }
      case 'resolve_relative': {
        const address = parseAddress(request.address), bytes = get(address + BigInt(request.offset), 4);
        if (!bytes) return reply({ type: 'error', code: 1005, message: 'Memory read failed' });
        const displacement = new DataView(bytes.buffer).getInt32(0, true);
        return reply({ type: 'resolve_relative_result', success: true, address: hex(address + BigInt(request.inst_size) + BigInt(displacement)) });
      }
      default: return reply({ type: 'error', code: 1000, message: `Unsupported demo command: ${request.type}` });
    }
  };
}

export async function createDemoBaseline() {
  const run = await checkBuild(DEMO_CATALOG, { rpc: createDemoRpc('baseline', { latencyMs: 0 }), mode: 'demo', label: '1.8.2 · known good' });
  const when = new Date(Date.now() - 2 * 86400000).toISOString();
  return { ...run, id: 'demo-baseline-1-8-2', startedAt: when, completedAt: when };
}
