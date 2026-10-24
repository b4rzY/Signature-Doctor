import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { WebSocket } from 'ws';
import { createDoctorServer } from '../server/index.mjs';
import { validateRequest, validateUpstream } from '../server/bridge.mjs';

async function fixture(t, options = {}) {
  const rootDir = await mkdtemp(path.join(import.meta.dirname, '.server-fixture-'));
  await mkdir(path.join(rootDir, 'public'));
  await mkdir(path.join(rootDir, 'shared'));
  await mkdir(path.join(rootDir, 'examples'));
  await writeFile(path.join(rootDir, 'public', 'index.html'), '<!doctype html><h1>Doctor</h1>');
  await writeFile(path.join(rootDir, 'shared', 'example.mjs'), 'export const number = 42;');
  await writeFile(path.join(rootDir, 'private.json'), '{"private":true}');
  await writeFile(path.join(rootDir, 'examples', 'angelscript-connect.as'), '// Portable connector fixture\nbool main() { return true; }\n');
  const app = createDoctorServer({ rootDir, port: 0, ...options });
  t.after(async () => { await app.close(); await rm(rootDir, { recursive: true, force: true }); });
  const bound = await app.start();
  const url = `http://127.0.0.1:${bound.port}`;
  return { app, url, rootDir };
}

async function agent(url) {
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/agent');
  await once(socket, 'open'); return socket;
}

async function rpc(url, request, extra = {}) {
  const response = await fetch(`${url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json', ...extra.headers }, body: JSON.stringify(request), ...extra });
  return { status: response.status, body: await response.json() };
}

test('read-only request boundary rejects mutations, unknown fields, unsafe addresses and unbounded scans', () => {
  assert.throws(() => validateRequest({ type: 'write', address: '0x1000', data: '90' }), /not allowed/);
  assert.throws(() => validateRequest({ type: 'ping', command: 'write' }), /Unsupported request property/);
  assert.throws(() => validateRequest({ type: 'read', address: 9007199254740993, size: 8 }), /strings/);
  assert.throws(() => validateRequest({ type: 'read', address: '0x10000000000000000', size: 8 }), /Addresses/);
  assert.throws(() => validateRequest({ type: 'read', address: '0x0', size: 8 }), /nonzero/);
  assert.throws(() => validateRequest({ type: 'read', address: '0x1000', size: 65537 }), /size/);
  assert.throws(() => validateRequest({ type: 'sig_scan_ida', pattern: '?? ??', module: 'app.exe' }), /concrete/);
  assert.throws(() => validateRequest({ type: 'sig_scan_ida', pattern: '48 8B ??', module: 'app.exe', find_all: false }), /find_all/);
  assert.throws(() => validateRequest({ type: 'resolve_relative', address: '0x1000', offset: 4, inst_size: 7 }), /must fit/);
  assert.equal(validateRequest({ type: 'resolve_relative', address: '0x1000', offset: 60, inst_size: 64 }).inst_size, 64);
  assert.deepEqual(validateRequest({ type: 'sig_scan_ida', pattern: '48 8b ?', module: 'app.exe' }), { type: 'sig_scan_ida', id: 0, pattern: '48 8B ??', module: 'app.exe', find_all: true });
});

test('batch budgets and upstream URL boundary prevent oversized reads and remote proxying', () => {
  const read = { address: '0x1000', size: 65536 };
  assert.equal(validateRequest({ type: 'read_batch', reads: Array(4).fill(read) }).reads.length, 4);
  assert.throws(() => validateRequest({ type: 'read_batch', reads: Array(5).fill(read) }), /256 KiB/);
  for (const url of ['https://example.com/rpc', 'http://169.254.169.254/rpc', 'http://127.0.0.1:9000/other', 'http://user:pass@localhost/rpc', 'http://localhost/rpc?url=https://example.com']) {
    assert.throws(() => validateUpstream(url), /WEB_MV_URL/);
  }
  assert.equal(validateUpstream('http://127.0.0.1:9000/rpc'), 'http://127.0.0.1:9000/rpc');
});

test('the dashboard serves static modules but blocks traversal, symlinks, cross-origin calls and invalid media types', async (t) => {
  const { url, rootDir } = await fixture(t);
  const page = await fetch(url);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Doctor/);
  assert.equal((await fetch(`${url}/shared/example.mjs`)).status, 200);
  assert.equal((await fetch(`${url}/%2e%2e%2fprivate.json`)).status, 400);
  assert.equal((await fetch(`${url}/server/index.mjs`)).status, 404);
  const connector = await fetch(`${url}/api/connector?path=private.json`);
  assert.equal(connector.status, 200);
  assert.match(connector.headers.get('content-type'), /^text\/plain/);
  assert.equal(connector.headers.get('content-disposition'), 'attachment; filename="angelscript-connect.as"');
  assert.match(await connector.text(), /Portable connector fixture/);
  if (process.platform !== 'win32') {
    await symlink(path.join(rootDir, 'private.json'), path.join(rootDir, 'public', 'escape.json'));
    assert.equal((await fetch(`${url}/escape.json`)).status, 404);
  }
  const foreign = await rpc(url, { type: 'ping' }, { headers: { 'content-type': 'application/json', origin: 'https://untrusted.example' } });
  assert.equal(foreign.status, 403);
  const noJSON = await fetch(`${url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"type":"ping"}' });
  assert.equal(noJSON.status, 415);
  const malformed = await fetch(`${url}/api/rpc`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  assert.equal((await rpc(url, { type: 'write' })).status, 403);
  assert.equal((await rpc(url, { type: 'ping' })).status, 503);
});

test('concurrent callers with the same id receive the correct out-of-order agent response', async (t) => {
  const { app, url } = await fixture(t);
  const socket = await agent(url);
  const observed = [];
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString()); observed.push(request);
    if (observed.length === 2) {
      for (const item of [...observed].reverse()) socket.send(JSON.stringify({ type: 'read_result', id: item.id, success: true, address: item.address, size: item.size, data: item.address === '0x1000' ? 'aa' : 'bb' }));
    }
  });
  const [first, second] = await Promise.all([
    rpc(url, { type: 'read', id: 7, address: '0x1000', size: 1 }),
    rpc(url, { type: 'read', id: 7, address: '0x2000', size: 1 }),
  ]);
  assert.notEqual(observed[0].id, observed[1].id);
  assert.equal(first.body.data, 'aa'); assert.equal(second.body.data, 'bb');
  assert.equal(first.body.id, 7); assert.equal(second.body.id, 7);
  assert.equal(app.bridge.pendingCount, 0);
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.agentConnected, true); assert.equal(status.mode, 'direct'); assert.equal(status.readOnly, true);
});

test('a mismatched response cannot silently satisfy a request', async (t) => {
  const { url } = await fixture(t);
  const socket = await agent(url);
  socket.on('message', (data) => { const request = JSON.parse(data.toString()); socket.send(JSON.stringify({ type: 'modules_result', id: request.id, modules: [] })); });
  const result = await rpc(url, { type: 'ping' });
  assert.equal(result.status, 502); assert.equal(result.body.code, 'ProtocolError');
});

test('portable protocol metadata is negotiated without requiring it from legacy agents', async (t) => {
  const { url } = await fixture(t);
  const socket = await agent(url);
  const capabilities = ['ping', 'modules', 'read', 'read_batch', 'sig_scan_ida', 'resolve_relative'];
  socket.on('message', (data) => {
    const request = JSON.parse(data.toString());
    socket.send(JSON.stringify({ type: 'ping_result', id: request.id, attached: true, pid: 123, base: '0x123456789abcdef', protocol: 'signature-doctor/1', connector: 'portable-angelscript', capabilities }));
  });
  const ping = await rpc(url, { type: 'ping' });
  assert.equal(ping.status, 200);
  assert.equal(ping.body.base, '0x123456789abcdef');
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.protocol, 'signature-doctor/1');
  assert.equal(status.connector, 'portable-angelscript');
  assert.deepEqual(status.capabilities, capabilities);
  assert.equal(status.version, '1.1.0');
  assert.equal((await rpc(url, { type: 'disassemble', address: '0x1000', size: 16 })).status, 501);
  const disconnected = once(socket, 'close'); socket.close(); await disconnected;
  const legacy = await agent(url);
  legacy.on('message', (data) => { const request = JSON.parse(data.toString()); legacy.send(JSON.stringify({ type: 'ping_result', id: request.id, attached: true, pid: 124, base: '0x140000000' })); });
  assert.equal((await rpc(url, { type: 'ping' })).status, 200);
  assert.equal((await (await fetch(`${url}/api/status`)).json()).protocol, null);
});

test('incompatible versions and incomplete portable capability sets fail explicitly', async (t) => {
  const { url } = await fixture(t);
  const socket = await agent(url);
  let metadata = { protocol: 'signature-doctor/2', capabilities: [] };
  socket.on('message', (data) => { const request = JSON.parse(data.toString()); socket.send(JSON.stringify({ type: 'ping_result', id: request.id, attached: true, ...metadata })); });
  const version = await rpc(url, { type: 'ping' });
  assert.equal(version.status, 502); assert.equal(version.body.code, 'IncompatibleProtocol');
  metadata = { protocol: 'signature-doctor/1', capabilities: ['ping', 'read'] };
  const incomplete = await rpc(url, { type: 'ping' });
  assert.equal(incomplete.status, 502); assert.equal(incomplete.body.code, 'IncompatibleProtocol');
});

test('disconnect rejects in-flight work and a later agent can reconnect', async (t) => {
  const { app, url } = await fixture(t);
  const socket = await agent(url);
  socket.once('message', () => socket.close());
  const result = await rpc(url, { type: 'ping' });
  assert.equal(result.status, 503); assert.equal(result.body.code, 'Disconnected');
  assert.equal(app.bridge.pendingCount, 0);
  const replacement = await agent(url);
  replacement.on('message', (data) => { const request = JSON.parse(data.toString()); replacement.send(JSON.stringify({ type: 'ping_result', id: request.id, attached: true, pid: 123, base: '0x1000' })); });
  assert.equal((await rpc(url, { type: 'ping' })).body.pid, 123);
});

test('unanswered requests time out and clean up correlation state', async (t) => {
  const { app, url } = await fixture(t, { timeoutMs: 60 });
  await agent(url);
  const result = await rpc(url, { type: 'ping' });
  assert.equal(result.status, 504); assert.equal(result.body.code, 'Timeout');
  assert.equal(app.bridge.pendingCount, 0);
});

test('a second core agent is refused while the first remains usable', async (t) => {
  const { url } = await fixture(t);
  const first = await agent(url);
  first.on('message', (data) => { const request = JSON.parse(data.toString()); first.send(JSON.stringify({ type: 'ping_result', id: request.id, attached: true })); });
  const second = new WebSocket(url.replace('http:', 'ws:') + '/agent');
  await assert.rejects(once(second, 'open'), /403/);
  assert.equal((await rpc(url, { type: 'ping' })).body.attached, true);
});

test('web-mv proxy forwards valid reads, reports attachment and never forwards forbidden commands', async (t) => {
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const request = JSON.parse(body); calls.push(request);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(request.type === 'ping' ? { type: 'ping_result', id: request.id, attached: true } : { type: 'read_result', id: request.id, success: true, size: 1, data: '2a' }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const { url } = await fixture(t, { upstream: `http://127.0.0.1:${upstream.address().port}/rpc` });
  const status = await (await fetch(`${url}/api/status`)).json();
  assert.equal(status.mode, 'web-mv'); assert.equal(status.agentConnected, true); assert.equal(status.attached, true);
  const result = await rpc(url, { type: 'read', address: '0x1000', size: 1 });
  assert.equal(result.body.data, '2a');
  assert.equal((await rpc(url, { type: 'write' })).status, 403);
  assert.deepEqual(calls.map((call) => call.type), ['ping', 'read']);
  const socket = new WebSocket(url.replace('http:', 'ws:') + '/agent');
  await assert.rejects(once(socket, 'open'), /403/);
});

test('web-mv redirects are rejected rather than followed to another host', async (t) => {
  const upstream = http.createServer((req, res) => { res.writeHead(302, { location: 'http://example.com/rpc' }); res.end(); });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); }));
  const { url } = await fixture(t, { upstream: `http://127.0.0.1:${upstream.address().port}/rpc` });
  const result = await rpc(url, { type: 'ping' });
  assert.equal(result.status, 503); assert.equal(result.body.code, 'Disconnected');
});
