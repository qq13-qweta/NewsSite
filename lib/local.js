// Airzone Local API backend.
// Talks directly to the Airzone Webserver / Webserver Hub / Aidoo on your LAN (HTTP, port 3000).
// No cloud, no account, no subscription.
//
//   POST http://<ip>:3000/api/v1/hvac {"systemID":127,"zoneID":0}   → read every zone
//   PUT  http://<ip>:3000/api/v1/hvac {"systemID":1,"zoneID":2,"on":1}  → change a zone

import { fetchJson, num, HttpError } from './model.js';

const MODE_TO_NAME = { 1: 'stop', 2: 'cool', 3: 'heat', 4: 'fan', 5: 'dry', 7: 'auto' };
const NAME_TO_MODE = Object.fromEntries(Object.entries(MODE_TO_NAME).map(([k, v]) => [v, Number(k)]));

// Different firmware versions accept different "all systems" IDs; try them in order.
const READ_ATTEMPTS = [
  { systemID: 127, zoneID: 0 }, // broadcast: all systems, all zones (newer firmware)
  { systemID: 0, zoneID: 0 },   // older firmware broadcast
  { systemID: 1, zoneID: 0 },   // single-system installs
];

// Recursively collect every object that looks like a zone ({systemID, zoneID, ...}).
function collectZones(node, out = []) {
  if (Array.isArray(node)) node.forEach((n) => collectZones(n, out));
  else if (node && typeof node === 'object') {
    if ('zoneID' in node && 'systemID' in node && Number(node.zoneID) > 0) out.push(node);
    else Object.values(node).forEach((v) => collectZones(v, out));
  }
  return out;
}

export class LocalBackend {
  constructor({ host, port = 3000 }) {
    if (!host) throw new HttpError(400, 'Local mode needs the Airzone Webserver IP address');
    this.base = `http://${host}:${port}/api/v1`;
    this.readParams = null; // remembers which read variant works
    this.zones = new Map(); // "sys:zone" → raw zone
  }

  get label() { return `Local API · ${new URL(this.base).host}`; }

  async readAll() {
    const attempts = this.readParams ? [this.readParams, ...READ_ATTEMPTS] : READ_ATTEMPTS;
    let lastErr;
    for (const params of attempts) {
      try {
        const res = await fetchJson(`${this.base}/hvac`, { method: 'POST', body: params });
        const zones = collectZones(res);
        if (zones.length) {
          this.readParams = params;
          return zones;
        }
      } catch (err) {
        lastErr = err;
        if (err.status === 502 || err.status === 504) throw err; // unreachable: no point retrying
      }
    }
    throw lastErr || new HttpError(502, 'The Airzone Webserver answered but reported no zones');
  }

  async getState() {
    const raw = await this.readAll();
    this.zones.clear();
    const systems = new Map();
    for (const z of raw) {
      const id = `${z.systemID}:${z.zoneID}`;
      this.zones.set(id, z);
      if (!systems.has(z.systemID)) {
        systems.set(z.systemID, { id: String(z.systemID), name: `System ${z.systemID}`, mode: null, modes: [], zones: [] });
      }
      const sys = systems.get(z.systemID);
      const fahrenheit = Number(z.units) === 1;
      // The "master" zone is the one that reports the list of available modes.
      if (Array.isArray(z.modes) && z.modes.length) {
        sys.modes = z.modes.map((m) => MODE_TO_NAME[m]).filter(Boolean);
        sys.masterZone = id;
      }
      if (sys.mode === null || sys.masterZone === id) sys.mode = MODE_TO_NAME[z.mode] ?? null;
      sys.zones.push({
        id,
        name: (z.name || `Zone ${z.zoneID}`).trim(),
        on: Number(z.on) === 1,
        temp: num(z.roomTemp),
        humidity: num(z.humidity),
        setpoint: num(z.setpoint),
        min: num(z.minTemp) ?? (fahrenheit ? 59 : 15),
        max: num(z.maxTemp) ?? (fahrenheit ? 86 : 30),
        step: num(z.temp_step) ?? (fahrenheit ? 1 : 0.5),
        units: fahrenheit ? 'F' : 'C',
      });
    }
    const list = [...systems.values()].sort((a, b) => Number(a.id) - Number(b.id));
    if (list.length === 1) list[0].name = 'All zones';
    for (const s of list) {
      s.zones.sort((a, b) => Number(a.id.split(':')[1]) - Number(b.id.split(':')[1]));
      delete s.masterZone;
    }
    this.systemMasters = new Map(
      [...systems.entries()].map(([sid]) => [String(sid), raw.find((z) => z.systemID === sid && Array.isArray(z.modes) && z.modes.length)]),
    );
    return { systems: list };
  }

  async put(systemID, zoneID, params) {
    const res = await fetchJson(`${this.base}/hvac`, { method: 'PUT', body: { systemID, zoneID, ...params } });
    if (res?.errors?.length) throw new HttpError(400, `Airzone refused the change: ${JSON.stringify(res.errors)}`);
    return res;
  }

  async setZone(id, { on, setpoint }) {
    const [systemID, zoneID] = id.split(':').map(Number);
    if (!zoneID) throw new HttpError(404, `Unknown zone ${id}`);
    const params = {};
    if (on !== undefined) params.on = on ? 1 : 0;
    if (setpoint !== undefined) params.setpoint = Number(setpoint);
    await this.put(systemID, zoneID, params);
  }

  async setMode(systemId, mode) {
    const code = NAME_TO_MODE[mode];
    if (!code) throw new HttpError(400, `Unknown mode ${mode}`);
    if (!this.systemMasters) await this.getState();
    const master = this.systemMasters.get(String(systemId));
    if (!master) throw new HttpError(400, 'This system does not allow changing the mode (no master zone found)');
    await this.put(master.systemID, master.zoneID, { mode: code });
  }
}
