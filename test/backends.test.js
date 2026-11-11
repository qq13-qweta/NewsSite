import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LocalBackend } from '../lib/local.js';
import { CloudBackend } from '../lib/cloud.js';
import { DemoBackend } from '../lib/demo.js';
import { fakeLocal, fakeCloud } from './fakes.js';

test('local: reads zones and maps them to the shared model', async () => {
  const dev = await fakeLocal();
  try {
    const b = new LocalBackend({ host: dev.host, port: dev.port });
    const { systems } = await b.getState();
    assert.equal(systems.length, 1);
    assert.deepEqual(systems[0].modes, ['stop', 'cool', 'heat', 'fan', 'dry']);
    assert.equal(systems[0].mode, 'cool');
    assert.deepEqual(systems[0].zones.map((z) => z.name), ['Living room', 'Trastero', 'Invitados']);
    assert.deepEqual(systems[0].zones[2], {
      id: '1:3', name: 'Invitados', on: true, temp: 21.2, humidity: 68, setpoint: 23.5, min: 15, max: 30, step: 0.5, units: 'C',
    });
  } finally { dev.close(); }
});

test('local: power, setpoint and mode changes send the right PUTs', async () => {
  const dev = await fakeLocal();
  try {
    const b = new LocalBackend({ host: dev.host, port: dev.port });
    await b.setZone('1:2', { on: true });
    await b.setZone('1:2', { setpoint: 22.5 });
    await b.setMode('1', 'heat'); // must go to the master zone (zone 1), not zone 2
    assert.deepEqual(dev.puts, [
      { systemID: 1, zoneID: 2, on: 1 },
      { systemID: 1, zoneID: 2, setpoint: 22.5 },
      { systemID: 1, zoneID: 1, mode: 3 },
    ]);
    const { systems } = await b.getState();
    assert.equal(systems[0].mode, 'heat');
    assert.equal(systems[0].zones[1].on, true);
  } finally { dev.close(); }
});

test('local: falls back for older firmware that rejects the broadcast system id', async () => {
  const dev = await fakeLocal({ broadcast: false });
  try {
    const b = new LocalBackend({ host: dev.host, port: dev.port });
    const { systems } = await b.getState();
    assert.equal(systems[0].zones.length, 3);
  } finally { dev.close(); }
});

test('local: unreachable webserver gives a clear error', async () => {
  const b = new LocalBackend({ host: '127.0.0.1', port: 1 });
  await assert.rejects(b.getState(), /Could not reach 127\.0\.0\.1:1/);
});

test('cloud: logs in, reads groups, uses the setpoint for the current mode', async () => {
  const cloud = await fakeCloud();
  try {
    const b = new CloudBackend({ email: 'me@example.com', password: 'secret', baseUrl: cloud.baseUrl });
    const { systems } = await b.getState();
    assert.equal(systems.length, 1);
    assert.equal(systems[0].name, 'Linda nueva'); // single group → installation name
    assert.equal(systems[0].mode, 'heat');
    assert.deepEqual(systems[0].modes, ['stop', 'auto', 'cool', 'heat', 'fan', 'dry']);
    const [living, master] = systems[0].zones;
    assert.equal(living.temp, 21.4);
    assert.equal(living.setpoint, 21); // heat setpoint, because mode is heat
    assert.equal(master.on, true);

    await b.setZone('dz1', { on: true, setpoint: 22.5 });
    await b.setMode(systems[0].id, 'cool');
    assert.deepEqual(cloud.patches, [
      { device: 'dz1', param: 'power', value: true, installation_id: 'inst1', opts: { units: 0 } },
      { device: 'dz1', param: 'setpoint_air_heat', value: 22.5, installation_id: 'inst1', opts: { units: 0 } },
      { device: 'dz1', param: 'mode', value: 2, installation_id: 'inst1', opts: { units: 0 } },
    ]);
  } finally { cloud.close(); }
});

test('cloud: refreshes an expired token transparently', async () => {
  const cloud = await fakeCloud();
  try {
    const b = new CloudBackend({ email: 'me@example.com', password: 'secret', baseUrl: cloud.baseUrl });
    await b.getState();
    cloud.expireToken();
    b.structure = null;
    const { systems } = await b.getState();
    assert.equal(systems[0].zones.length, 2);
  } finally { cloud.close(); }
});

test('cloud: wrong password is reported', async () => {
  const cloud = await fakeCloud();
  try {
    const b = new CloudBackend({ email: 'me@example.com', password: 'nope', baseUrl: cloud.baseUrl });
    await assert.rejects(b.getState(), /401/);
  } finally { cloud.close(); }
});

test('demo: changes stick and setpoint is clamped', async () => {
  const b = new DemoBackend();
  await b.setZone('1:1', { on: true, setpoint: 99 });
  const { systems } = await b.getState();
  assert.equal(systems[0].zones[0].on, true);
  assert.equal(systems[0].zones[0].setpoint, 30);
});
