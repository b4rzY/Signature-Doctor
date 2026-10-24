import { WebSocket } from 'ws';

export class BridgeError extends Error {
  constructor(message, code = 'BridgeError', status = 502) {
    super(message); this.name = 'BridgeError'; this.code = code; this.status = status;
  }
}

const MAX_ADDRESS = (1n << 64n) - 1n;
const MAX_RESPONSE = 2 * 1024 * 1024;
const PORTABLE_PROTOCOL = 'signature-doctor/1';
const REQUIRED_CAPABILITIES = ['ping', 'modules', 'read', 'read_batch', 'sig_scan_ida', 'resolve_relative'];
const invalid = (message) => { throw new BridgeError(message, 'InvalidRequest', 400); };

function integer(value, name, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) invalid(`${name} must be an integer from ${min} to ${max}.`);
  return value;
}

function address(value) {
  if (typeof value !== 'string' || !/^(?:0x[0-9a-fA-F]{1,16}|[0-9]{1,20})$/.test(value)) invalid('Addresses must be hexadecimal or decimal strings.');
  const n = BigInt(value);
  if (n < 1n || n > MAX_ADDRESS) invalid('Address is outside the nonzero 64-bit range.');
  return `0x${n.toString(16)}`;
}

function moduleName(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 260 || /[\x00-\x1f\x7f]/.test(value)) invalid('A module name of 1–260 characters is required.');
  return value;
}

function onlyKeys(value, allowed) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) invalid(`Unsupported request property: ${key}.`);
}

/** Strict read-only boundary: never forward arbitrary client commands to the process. */
export function validateRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('Expected a JSON request object.');
  const id = input.id === undefined ? 0 : integer(input.id, 'id', 0, 2147483647);
  const type = input.type;
  if (type === 'ping' || type === 'modules') {
    onlyKeys(input, ['type', 'id']); return { type, id };
  }
  if (type === 'read' || type === 'disassemble') {
    onlyKeys(input, ['type', 'id', 'address', 'size']);
    return { type, id, address: address(input.address), size: integer(input.size, 'size', 1, type === 'read' ? 65536 : 4096) };
  }
  if (type === 'read_batch') {
    onlyKeys(input, ['type', 'id', 'reads']);
    if (!Array.isArray(input.reads) || input.reads.length < 1 || input.reads.length > 64) invalid('read_batch requires 1–64 entries.');
    let total = 0;
    const reads = input.reads.map((read) => {
      if (!read || typeof read !== 'object' || Array.isArray(read)) invalid('Every read must be an object.');
      onlyKeys(read, ['address', 'size']);
      const size = integer(read.size, 'size', 1, 65536); total += size;
      return { address: address(read.address), size };
    });
    if (total > 262144) invalid('A read_batch may request at most 256 KiB.');
    return { type, id, reads };
  }
  if (type === 'sig_scan_ida') {
    onlyKeys(input, ['type', 'id', 'module', 'pattern', 'find_all']);
    if (typeof input.pattern !== 'string' || input.pattern.length > 1024) invalid('A bounded IDA byte pattern is required.');
    const tokens = input.pattern.trim().split(/\s+/);
    if (tokens.length > 256 || !tokens.every((token) => /^(?:[0-9a-fA-F]{2}|\?{1,2})$/.test(token)) || !tokens.some((token) => /^[0-9a-fA-F]{2}$/.test(token))) invalid('Patterns require 1–256 byte tokens and at least one concrete byte.');
    if (input.find_all !== undefined && input.find_all !== true) invalid('Signature Doctor requires find_all: true to detect ambiguous signatures.');
    return { type, id, module: moduleName(input.module), pattern: tokens.map((token) => token.startsWith('?') ? '??' : token.toUpperCase()).join(' '), find_all: true };
  }
  if (type === 'resolve_relative') {
    onlyKeys(input, ['type', 'id', 'address', 'offset', 'inst_size']);
    const offset = integer(input.offset, 'offset', 0, 60);
    const inst_size = integer(input.inst_size, 'inst_size', 4, 64);
    if (offset + 4 > inst_size) invalid('The 4-byte relative displacement must fit inside the instruction.');
    return { type, id, address: address(input.address), offset, inst_size };
  }
  throw new BridgeError(`Command ${typeof type === 'string' ? type : '(missing)'} is not allowed. This bridge is read-only.`, 'ForbiddenCommand', 403);
}

export function validateUpstream(value) {
  if (!value) return null;
  let url;
  try { url = new URL(value); } catch { throw new Error('WEB_MV_URL must be a valid loopback HTTP URL ending in /rpc.'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/rpc') {
    throw new Error('WEB_MV_URL must use http://127.0.0.1, http://localhost or http://[::1], with path /rpc and no credentials/query.');
  }
  return url.href;
}

async function boundedJSON(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new BridgeError('The relay returned an empty response.', 'ProtocolError');
  let total = 0; const chunks = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_RESPONSE) throw new BridgeError('The relay response exceeded 2 MiB.', 'ProtocolError');
      chunks.push(value);
    }
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('The relay returned malformed JSON.', 'ProtocolError'); }
}

/** One runtime agent socket, many independently correlated HTTP callers. */
export class AgentBridge {
  constructor({ timeoutMs = 30000, upstream = null, fetchImpl = globalThis.fetch, maxPending = 32 } = {}) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) throw new Error('timeoutMs must be an integer from 1 to 120000.');
    this.timeoutMs = timeoutMs; this.upstream = validateUpstream(upstream); this.fetchImpl = fetchImpl;
    this.maxPending = maxPending; this.pending = new Map(); this.sequence = 0; this.agent = null; this.proxyPending = 0;
    this.proxyControllers = new Set(); this.closed = false; this.agentInfo = null;
  }
  get mode() { return this.upstream ? 'web-mv' : 'direct'; }
  get connected() { return this.agent?.readyState === WebSocket.OPEN; }
  get pendingCount() { return this.pending.size + this.proxyPending; }

  recordProtocol(message) {
    // Legacy/native web-mv agents omit metadata and remain compatible.
    if (message.type !== 'ping_result') return;
    if (message.protocol === undefined) { this.agentInfo = null; return; }
    this.agentInfo = null;
    if (message.protocol !== PORTABLE_PROTOCOL) throw new BridgeError(`Unsupported agent protocol ${String(message.protocol)}. Load the connector bundled with this version of Signature Doctor.`, 'IncompatibleProtocol', 502);
    if (!Array.isArray(message.capabilities) || message.capabilities.length > 32 || message.capabilities.some(value => typeof value !== 'string' || value.length > 64)
      || !REQUIRED_CAPABILITIES.every(value => message.capabilities.includes(value))) {
      throw new BridgeError('The runtime connector does not report the required read-only capabilities. Load examples/angelscript-connect.as.', 'IncompatibleProtocol', 502);
    }
    this.agentInfo = { protocol: PORTABLE_PROTOCOL, connector: message.connector === 'portable-angelscript' ? message.connector : 'custom', capabilities: [...new Set(message.capabilities)] };
  }

  attach(socket) {
    if (this.closed || this.upstream || this.agent) { socket.close(1008, 'Only one direct runtime agent is permitted.'); return false; }
    this.agent = socket;
    socket.on('message', (data, binary) => {
      if (binary) { socket.close(1003, 'Expected JSON text.'); return; }
      let message;
      try { message = JSON.parse(data.toString()); } catch { socket.close(1007, 'Malformed JSON.'); return; }
      if (!message || typeof message !== 'object' || Array.isArray(message) || !Number.isSafeInteger(message.id) || typeof message.type !== 'string') return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      if (message.type !== entry.expectedType && message.type !== 'error') {
        entry.finish(new BridgeError(`Expected ${entry.expectedType}; received ${message.type}.`, 'ProtocolError')); return;
      }
      try { this.recordProtocol(message); } catch (error) { entry.finish(error); return; }
      entry.finish(null, { ...message, id: entry.clientId });
    });
    const disconnected = () => {
      if (this.agent !== socket) return;
      this.agent = null; this.agentInfo = null;
      for (const entry of [...this.pending.values()]) entry.finish(new BridgeError('The runtime agent disconnected during the request. Reconnect and run the build again.', 'Disconnected', 503));
    };
    socket.on('close', disconnected);
    socket.on('error', disconnected);
    return true;
  }

  async request(raw, signal) {
    const request = validateRequest(raw);
    if (this.closed) throw new BridgeError('The bridge is shutting down.', 'Disconnected', 503);
    if (signal?.aborted) throw new BridgeError('The request was cancelled.', 'Aborted', 499);
    if (this.pendingCount >= this.maxPending) throw new BridgeError('Too many pending requests. Wait for the current check to finish.', 'Busy', 429);
    if (this.agentInfo && !this.agentInfo.capabilities.includes(request.type)) throw new BridgeError(`The connected runtime does not provide ${request.type}.`, 'UnsupportedCapability', 501);
    if (this.upstream) return this.proxy(request, signal);
    if (!this.connected) throw new BridgeError('No runtime agent connected. Load examples/angelscript-connect.as or configure WEB_MV_URL.', 'Disconnected', 503);
    const id = this.sequence = this.sequence >= 2147483647 ? 1 : this.sequence + 1;
    return new Promise((resolve, reject) => {
      const abort = () => finish(new BridgeError('The request was cancelled.', 'Aborted', 499));
      let timer;
      const finish = (error, result) => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(result);
      };
      this.pending.set(id, { finish, clientId: request.id, expectedType: `${request.type}_result` });
      timer = setTimeout(() => finish(new BridgeError('The runtime agent did not reply before the request timeout.', 'Timeout', 504)), this.timeoutMs);
      timer.unref?.();
      signal?.addEventListener('abort', abort, { once: true });
      this.agent.send(JSON.stringify({ ...request, id }), (error) => { if (error) finish(new BridgeError('Could not send the request to the runtime agent.', 'Disconnected', 503)); });
    });
  }

  async proxy(request, signal) {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error('timeout')), this.timeoutMs);
    timer.unref?.(); this.proxyPending++; this.proxyControllers.add(controller);
    try {
      const response = await this.fetchImpl(this.upstream, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-mv-client': 'signature-doctor' }, body: JSON.stringify(request),
        signal: controller.signal, redirect: 'error',
      });
      if (!response.ok) throw new BridgeError(`web-mv replied with HTTP ${response.status}. Check its core agent connection.`, 'UpstreamError', response.status === 503 ? 503 : 502);
      const result = await boundedJSON(response);
      if (!result || typeof result !== 'object' || Array.isArray(result) || ![`${request.type}_result`, 'error'].includes(result.type)) throw new BridgeError('web-mv returned an unexpected RPC response.', 'ProtocolError');
      this.recordProtocol(result);
      return { ...result, id: request.id };
    } catch (error) {
      if (error instanceof BridgeError) throw error;
      if (signal?.aborted) throw new BridgeError('The request was cancelled.', 'Aborted', 499);
      if (controller.signal.aborted) throw new BridgeError('web-mv did not reply before the request timeout.', 'Timeout', 504);
      throw new BridgeError('Cannot reach web-mv. Start its relay and runtime agent, then try again.', 'Disconnected', 503);
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', abort); this.proxyControllers.delete(controller); this.proxyPending--;
    }
  }

  async status() {
    let agentConnected = Boolean(this.connected), attached = null;
    if (this.upstream) {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), Math.min(2500, this.timeoutMs));
      try { const result = await this.request({ type: 'ping' }, controller.signal); agentConnected = result.type === 'ping_result'; attached = result.attached === true; }
      catch { agentConnected = false; attached = false; this.agentInfo = null; }
      finally { clearTimeout(timer); }
    }
    return { agentConnected, attached, mode: this.mode, upstream: this.upstream, pendingRequests: this.pendingCount, version: '1.1.0', readOnly: true, protocol: this.agentInfo?.protocol ?? null, connector: this.agentInfo?.connector ?? null, capabilities: this.agentInfo?.capabilities ?? null };
  }

  close() {
    this.closed = true;
    for (const entry of [...this.pending.values()]) entry.finish(new BridgeError('The bridge is shutting down.', 'Disconnected', 503));
    for (const controller of this.proxyControllers) controller.abort();
    this.agent?.terminate(); this.agent = null; this.agentInfo = null;
  }
}
