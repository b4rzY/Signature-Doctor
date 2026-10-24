import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFile, stat, realpath } from 'node:fs/promises';
import { WebSocketServer } from 'ws';
import { BridgeError, AgentBridge } from './bridge.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function securityHeaders(res) {
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('x-frame-options', 'DENY');
  res.setHeader('content-security-policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
}

function validOrigin(req, dev) {
  let host;
  try { host = new URL(`http://${req.headers.host ?? ''}`); } catch { return false; }
  if (!host.hostname || host.username || host.password || host.pathname !== '/') return false;
  if (!dev && !['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname)) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return ['http:', 'https:'].includes(parsed.protocol) && parsed.host.toLowerCase() === host.host.toLowerCase() && parsed.origin === origin;
  } catch { return false; }
}

async function bodyJSON(req) {
  if (!/^application\/json(?:\s*;|\s*$)/i.test(req.headers['content-type'] ?? '')) throw new BridgeError('Use Content-Type: application/json.', 'UnsupportedMediaType', 415);
  if (Number(req.headers['content-length']) > 32768) throw new BridgeError('Request bodies are limited to 32 KiB.', 'TooLarge', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 32768) throw new BridgeError('Request bodies are limited to 32 KiB.', 'TooLarge', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new BridgeError('The request body is not valid JSON.', 'InvalidJSON', 400); }
}

export function createDoctorServer({ rootDir = ROOT, host = '127.0.0.1', port = 3210, dev = false, upstream = null, timeoutMs = 30000, fetchImpl } = {}) {
  const bridge = new AgentBridge({ upstream, timeoutMs, fetchImpl });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 2 * 1024 * 1024, perMessageDeflate: false });
  const server = http.createServer(async (req, res) => {
    securityHeaders(res);
    try {
      if (!validOrigin(req, dev)) { json(res, { type: 'error', code: 'ForbiddenOrigin', message: 'Open Signature Doctor from this server’s own URL.' }, 403); return; }
      let pathname;
      try { pathname = decodeURIComponent((req.url ?? '/').split('?')[0]); } catch { throw new BridgeError('Malformed URL.', 'BadPath', 400); }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').includes('..') || !pathname.startsWith('/')) throw new BridgeError('Invalid path.', 'BadPath', 400);
      if (pathname === '/api/status' && req.method === 'GET') { json(res, await bridge.status()); return; }
      if (pathname === '/api/connector' && req.method === 'GET') {
        const connector = await readFile(path.join(rootDir, 'examples', 'angelscript-connect.as'));
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': 'attachment; filename="angelscript-connect.as"', 'content-length': connector.length, 'cache-control': 'no-cache' });
        res.end(connector); return;
      }
      if (pathname === '/api/rpc' && req.method === 'POST') {
        const data = await bodyJSON(req);
        const controller = new AbortController();
        const close = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', close);
        try { const result = await bridge.request(data, controller.signal); if (!res.destroyed) json(res, result); }
        finally { res.off('close', close); }
        return;
      }
      if (pathname.startsWith('/api/')) { json(res, { type: 'error', code: 'NotFound', message: 'Unknown endpoint or method.' }, 404); return; }
      if (req.method !== 'GET' && req.method !== 'HEAD') { json(res, { type: 'error', code: 'MethodNotAllowed', message: 'Use GET or HEAD for static files.' }, 405); return; }
      const publicRoot = path.join(rootDir, 'public');
      const sharedRoot = path.join(rootDir, 'shared');
      const base = pathname.startsWith('/shared/') ? sharedRoot : publicRoot;
      const relative = pathname.startsWith('/shared/') ? pathname.slice(8) : pathname === '/' ? 'index.html' : pathname.slice(1);
      const candidate = path.resolve(base, relative);
      if (!candidate.startsWith(`${base}${path.sep}`)) throw new BridgeError('Invalid path.', 'BadPath', 400);
      let resolved, info;
      try { resolved = await realpath(candidate); info = await stat(resolved); } catch { json(res, { type: 'error', code: 'NotFound', message: 'File not found.' }, 404); return; }
      if (!resolved.startsWith(`${await realpath(base)}${path.sep}`) || !info.isFile()) { json(res, { type: 'error', code: 'NotFound', message: 'File not found.' }, 404); return; }
      const extension = path.extname(resolved);
      if (!MIME[extension]) { json(res, { type: 'error', code: 'NotFound', message: 'File not found.' }, 404); return; }
      res.writeHead(200, { 'content-type': MIME[extension], 'content-length': info.size, 'cache-control': 'no-cache' });
      if (req.method === 'HEAD') res.end(); else res.end(await readFile(resolved));
    } catch (error) {
      if (res.destroyed || res.headersSent) return;
      json(res, { type: 'error', code: error instanceof BridgeError ? error.code : 'InternalError', message: error instanceof BridgeError ? error.message : 'The local server could not complete the request.' }, error instanceof BridgeError ? error.status : 500);
    }
  });
  server.requestTimeout = 45000;
  server.headersTimeout = 10000;
  server.on('upgrade', (req, socket, head) => {
    if (req.url !== '/agent' || !validOrigin(req, dev) || bridge.upstream || bridge.agent) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); socket.destroy(); return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => bridge.attach(ws));
  });
  return {
    server, bridge,
    start: () => new Promise((resolve, reject) => {
      const onError = (error) => { server.off('listening', onListening); reject(error); };
      const onListening = () => { server.off('error', onError); resolve(server.address()); };
      server.once('error', onError); server.once('listening', onListening); server.listen(port, host);
    }),
    close: () => new Promise((resolve) => { bridge.close(); wss.close(); server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const dev = process.argv.includes('--dev');
  const port = Number(process.env.PORT ?? 3210);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be an integer from 1 to 65535.');
  const app = createDoctorServer({ dev, host: dev ? '0.0.0.0' : '127.0.0.1', port, upstream: process.env.WEB_MV_URL, timeoutMs: Number(process.env.RPC_TIMEOUT_MS ?? 30000) });
  app.start().then(() => {
    console.log(`Signature Doctor · http://127.0.0.1:${port}`);
    console.log(app.bridge.upstream ? `Using existing web-mv relay: ${app.bridge.upstream}` : `Runtime agent: ws://127.0.0.1:${port}/agent`);
    if (dev) console.log('Development preview listens on all interfaces. Use npm start for a loopback-only session.');
  }).catch((error) => { console.error(`Could not start Signature Doctor: ${error.message}`); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { app.close().then(() => process.exit(0)); });
}
