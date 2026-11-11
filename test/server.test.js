import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fakeLocal } from './fakes.js';

const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aircon-'));
process.env.AIRCON_CONFIG = path.join(tmp, 'config.json');
process.env.NODE_ENV = 'test';
const { server } = await import('../server.js');

let base;
let dev;
before(async () => {
  dev = await fakeLocal();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); dev.close(); });

const call = async (p, body) => {
  const res = await fetch(base + p, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  return { status: res.status, json: await res.json() };
};

test('serves the app shell', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Aircon<\/title>/);
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});

test('starts in demo mode', async () => {
  const { json } = await call('/api/state');
  assert.equal(json.mode, 'demo');
  assert.equal(json.systems[0].zones[0].name, 'Living room');
});

test('rejects a config that cannot connect and keeps the old one', async () => {
  const { status, json } = await call('/api/config', { mode: 'local', host: '127.0.0.1', port: 1 });
  assert.equal(status, 502);
  assert.match(json.error, /Could not reach/);
  assert.equal((await call('/api/config')).json.mode, 'demo');
});

test('switches to local mode, saves config, and controls zones', async () => {
  const saved = await call('/api/config', { mode: 'local', host: dev.host, port: dev.port });
  assert.equal(saved.status, 200);
  const file = JSON.parse(await fs.readFile(process.env.AIRCON_CONFIG, 'utf8'));
  assert.equal(file.host, dev.host);

  let { json } = await call('/api/state');
  assert.equal(json.mode, 'local');
  assert.equal(json.systems[0].zones.length, 3);

  assert.equal((await call('/api/zones/1%3A1', { setpoint: 26 })).status, 200);
  assert.equal(dev.zones[0].setpoint, 26);

  assert.equal((await call('/api/all/power', { on: true })).status, 200);
  assert.deepEqual(dev.zones.map((z) => z.on), [1, 1, 1]);

  assert.equal((await call('/api/systems/1/power', { on: false })).status, 200);
  assert.deepEqual(dev.zones.map((z) => z.on), [0, 0, 0]);

  assert.equal((await call('/api/systems/1/mode', { mode: 'dry' })).status, 200);
  ({ json } = await call('/api/state'));
  assert.equal(json.systems[0].mode, 'dry');
});

test('unknown routes 404 with a message', async () => {
  const { status, json } = await call('/api/nope');
  assert.equal(status, 404);
  assert.ok(json.error);
});
