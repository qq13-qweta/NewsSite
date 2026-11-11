// Aircon — a tiny, dependency-free web app to control an Airzone HVAC system.
// Run `npm start`, open http://<this-machine>:8080 on your phone, "Add to Home Screen".

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from './lib/model.js';
import { LocalBackend } from './lib/local.js';
import { CloudBackend } from './lib/cloud.js';
import { DemoBackend } from './lib/demo.js';
import { discover } from './lib/discover.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CONFIG_PATH = process.env.AIRCON_CONFIG || path.join(ROOT, 'data', 'config.json');
const PORT = Number(process.env.PORT || 8080);
const PIN = process.env.AIRCON_PIN || '';

// ---------- config ----------

async function loadConfig() {
  let cfg = { mode: 'demo' };
  try { cfg = { ...cfg, ...JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8')) }; } catch { /* first run */ }
  // Environment variables win over the saved file (handy for Docker).
  if (process.env.AIRZONE_HOST) cfg = { ...cfg, mode: 'local', host: process.env.AIRZONE_HOST };
  if (process.env.AIRZONE_PORT) cfg.port = Number(process.env.AIRZONE_PORT);
  if (process.env.AIRZONE_EMAIL) cfg = { ...cfg, mode: 'cloud', email: process.env.AIRZONE_EMAIL };
  if (process.env.AIRZONE_PASSWORD) cfg.password = process.env.AIRZONE_PASSWORD;
  if (process.env.AIRZONE_MODE) cfg.mode = process.env.AIRZONE_MODE;
  return cfg;
}

async function saveConfig(cfg) {
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function makeBackend(cfg) {
  if (cfg.mode === 'local') return new LocalBackend({ host: cfg.host, port: cfg.port || 3000 });
  if (cfg.mode === 'cloud') return new CloudBackend({ email: cfg.email, password: cfg.password });
  return new DemoBackend();
}

let config = await loadConfig();
let backend;
let backendError = null;
try { backend = makeBackend(config); } catch (err) { backend = new DemoBackend(); backendError = err.message; }

// Run device commands one at a time so rapid taps don't trip over each other.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

// ---------- http helpers ----------

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json',
};

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  let data = '';
  for await (const chunk of req) {
    data += chunk;
    if (data.length > 64 * 1024) throw new HttpError(413, 'Body too large');
  }
  if (!data) return {};
  try { return JSON.parse(data); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');
  let file = path.normalize(path.join(PUBLIC, decodeURIComponent(url.pathname)));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  try {
    if ((await fs.stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    send(res, 404, { error: 'Not found' });
  }
}

function publicConfig() {
  return {
    mode: config.mode, host: config.host || '', port: config.port || 3000,
    email: config.email || '', hasPassword: Boolean(config.password),
  };
}

async function state() {
  const s = await backend.getState();
  return { label: backend.label, mode: config.mode, warning: backendError, ...s };
}

// ---------- routes ----------

async function handleApi(req, res, url) {
  if (PIN && req.headers['x-pin'] !== PIN) throw new HttpError(401, 'PIN required');
  const parts = url.pathname.split('/').filter(Boolean).slice(1).map(decodeURIComponent); // drop "api"
  const hasId = ['zones', 'systems'].includes(parts[0]) && parts.length >= 2;
  const route = `${req.method} /${parts.map((p, i) => (hasId && i === 1 ? ':id' : p)).join('/')}`;

  switch (route) {
    case 'GET /state':
      return send(res, 200, await serial(state));

    case 'POST /zones/:id': {
      const body = await readBody(req);
      await serial(() => backend.setZone(parts[1], { on: body.on, setpoint: body.setpoint }));
      return send(res, 200, { ok: true });
    }

    case 'POST /systems/:id/mode': {
      const { mode } = await readBody(req);
      await serial(() => backend.setMode(parts[1], mode));
      return send(res, 200, { ok: true });
    }

    case 'POST /systems/:id/power':
    case 'POST /all/power': {
      const { on } = await readBody(req);
      const all = parts[0] === 'all';
      await serial(async () => {
        const { systems } = await backend.getState();
        for (const s of systems) {
          if (!all && s.id !== parts[1]) continue;
          for (const z of s.zones) if (z.on !== Boolean(on)) await backend.setZone(z.id, { on: Boolean(on) });
        }
      });
      return send(res, 200, { ok: true });
    }

    case 'GET /config':
      return send(res, 200, publicConfig());

    case 'POST /config': {
      const body = await readBody(req);
      const next = {
        mode: ['local', 'cloud', 'demo'].includes(body.mode) ? body.mode : 'demo',
        host: String(body.host || '').trim(),
        port: Number(body.port) || 3000,
        email: String(body.email || '').trim(),
        // Keep the stored password if the form left it blank.
        password: body.password ? String(body.password) : config.password,
      };
      const candidate = makeBackend(next); // throws a 400 on missing fields
      await candidate.getState();           // only save settings that actually work
      config = next;
      backend = candidate;
      backendError = null;
      await saveConfig(config);
      return send(res, 200, { ok: true, config: publicConfig() });
    }

    case 'POST /discover':
      return send(res, 200, await discover());

    default:
      throw new HttpError(404, `No route ${route}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else await serveStatic(req, res);
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err.message);
    send(res, status, { error: err.message });
  }
});

if (process.env.NODE_ENV !== 'test' || process.env.AIRCON_LISTEN) {
  server.listen(PORT, () => {
    console.log(`Aircon running on http://localhost:${PORT}  →  ${backend.label}`);
    if (backendError) console.log(`Config problem: ${backendError} (falling back to demo mode)`);
  });
}

export { server };
