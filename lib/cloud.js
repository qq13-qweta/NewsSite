// Airzone Cloud backend (same API the official app and the Home Assistant integration use).
// Use this if your Webserver does not expose the Local API, or you want control from outside home
// without a VPN. Free account features only — nothing here needs the paid "Cloud Plan".
//
//   POST  /api/v1/auth/login                       {email, password} → {token, refreshToken}
//   GET   /api/v1/installations                    → list of installations
//   GET   /api/v1/installations/{id}               → groups + devices
//   GET   /api/v1/devices/{id}/status?installation_id=…
//   PATCH /api/v1/devices/{id}                     {param, value, installation_id, opts:{units:0}}

import { fetchJson, num, HttpError } from './model.js';

const DEFAULT_BASE = 'https://m.airzonecloud.com/api/v1';
const ZONE_TYPES = new Set(['az_zone', 'aidoo', 'aidoo_pro']);
const STRUCTURE_TTL = 5 * 60 * 1000;

const MODE_TO_NAME = {
  0: 'stop', 1: 'auto', 2: 'cool', 3: 'heat', 4: 'fan', 5: 'dry',
  6: 'heat', 7: 'heat', 8: 'heat', 9: 'heat', // emergency / air / radiant / combined heat
  10: 'cool', 11: 'cool', 12: 'cool',         // air / radiant / combined cool
};

// Which setpoint field applies in each mode (first one present in the status wins).
const SETPOINT_KEYS = {
  cool: [['setpoint_air_cool', 'cool_air']],
  heat: [['setpoint_air_heat', 'hot_air']],
  auto: [['setpoint_air_auto', 'auto_air'], ['setpoint_air_cool', 'cool_air']],
  dry: [['setpoint_air_dry', 'dry_air'], ['setpoint_air_cool', 'cool_air']],
  fan: [['setpoint_air_vent', 'vent_air'], ['setpoint_air_cool', 'cool_air']],
  stop: [['setpoint_air_stop', 'stop_air'], ['setpoint_air_cool', 'cool_air'], ['setpoint_air_heat', 'hot_air']],
};

function pickSetpoint(status, modeName) {
  const candidates = [...(SETPOINT_KEYS[modeName] || []), ...SETPOINT_KEYS.cool, ...SETPOINT_KEYS.heat];
  for (const [key, range] of candidates) {
    if (status[key] !== undefined) {
      return {
        key,
        value: num(status[key]),
        min: num(status[`range_sp_${range}_min`]),
        max: num(status[`range_sp_${range}_max`]),
      };
    }
  }
  return { key: null, value: null, min: null, max: null };
}

export class CloudBackend {
  constructor({ email, password, baseUrl = DEFAULT_BASE }) {
    this.base = baseUrl;
    if (!email || !password) throw new HttpError(400, 'Cloud mode needs your Airzone Cloud email and password');
    this.email = email;
    this.password = password;
    this.token = null;
    this.refreshToken = null;
    this.structure = null; // { at, systems: [{id, name, installationId, devices: [{id, name}]}] }
    this.status = new Map(); // deviceId → { installationId, status, setpointKey, systemId }
  }

  get label() { return `Airzone Cloud · ${this.email}`; }

  async login() {
    const res = await fetchJson(`${this.base}/auth/login`, { method: 'POST', body: { email: this.email, password: this.password } });
    if (!res?.token) throw new HttpError(401, 'Airzone Cloud login failed — check email and password');
    this.token = res.token;
    this.refreshToken = res.refreshToken;
  }

  async refresh() {
    if (!this.refreshToken) return this.login();
    try {
      const res = await fetchJson(`${this.base}/auth/refreshToken/${encodeURIComponent(this.refreshToken)}`);
      this.token = res.token;
      this.refreshToken = res.refreshToken || this.refreshToken;
    } catch {
      await this.login();
    }
  }

  async api(path, opts = {}) {
    if (!this.token) await this.login();
    const call = () => fetchJson(`${this.base}${path}`, { ...opts, headers: { Authorization: `Bearer ${this.token}` } });
    try {
      return await call();
    } catch (err) {
      if (err.status !== 401) throw err;
      await this.refresh();
      return call();
    }
  }

  async loadStructure() {
    if (this.structure && Date.now() - this.structure.at < STRUCTURE_TTL) return this.structure;
    const list = await this.api('/installations');
    const installations = list?.installations || (Array.isArray(list) ? list : []);
    const systems = [];
    for (const inst of installations) {
      const instId = inst.installation_id || inst.id;
      const detail = await this.api(`/installations/${encodeURIComponent(instId)}`);
      const groups = detail?.groups || inst.groups || [];
      for (const g of groups) {
        const devices = (g.devices || [])
          .filter((d) => ZONE_TYPES.has(d.type))
          .map((d) => ({ id: d.device_id || d.id, name: d.name }));
        if (!devices.length) continue;
        const name = installations.length > 1 || groups.length === 1
          ? [inst.name, groups.length > 1 ? g.name : null].filter(Boolean).join(' · ')
          : g.name;
        systems.push({ id: `${instId}/${g.group_id || g.id}`, name: name || 'Zones', installationId: instId, devices });
      }
    }
    this.structure = { at: Date.now(), systems };
    return this.structure;
  }

  async getState() {
    const { systems } = await this.loadStructure();
    const out = [];
    for (const sys of systems) {
      const statuses = await Promise.all(
        sys.devices.map((d) =>
          this.api(`/devices/${encodeURIComponent(d.id)}/status?installation_id=${encodeURIComponent(sys.installationId)}`)
            .catch((err) => ({ __error: err.message })),
        ),
      );
      let mode = null;
      let modes = [];
      let master = null;
      const zones = sys.devices.map((d, i) => {
        const st = statuses[i] || {};
        const modeName = MODE_TO_NAME[st.mode] ?? null;
        const available = Array.isArray(st.mode_available) ? st.mode_available : [];
        if (available.length && !master) {
          master = d.id;
          modes = [...new Set(available.map((m) => MODE_TO_NAME[m]).filter(Boolean))];
          mode = modeName;
        }
        if (mode === null) mode = modeName;
        const sp = pickSetpoint(st, modeName);
        this.status.set(d.id, { installationId: sys.installationId, status: st, setpointKey: sp.key, systemId: sys.id });
        return {
          id: d.id,
          name: st.name || d.name || 'Zone',
          on: st.power === true || st.power === 1,
          temp: num(st.local_temp),
          humidity: num(st.humidity),
          setpoint: sp.value,
          min: sp.min ?? 15,
          max: sp.max ?? 30,
          step: num(st.step) ?? 0.5,
          units: 'C',
          offline: Boolean(st.__error) || st.isConnected === false || st.is_connected === false,
        };
      });
      out.push({ id: sys.id, name: sys.name, mode, modes, zones, masterDevice: master });
    }
    this.masters = new Map(out.map((s) => [s.id, s.masterDevice]));
    out.forEach((s) => delete s.masterDevice);
    return { systems: out };
  }

  async patch(deviceId, param, value) {
    let info = this.status.get(deviceId);
    if (!info) { await this.getState(); info = this.status.get(deviceId); }
    if (!info) throw new HttpError(404, `Unknown zone ${deviceId}`);
    await this.api(`/devices/${encodeURIComponent(deviceId)}`, {
      method: 'PATCH',
      body: { param, value, installation_id: info.installationId, opts: { units: 0 } },
    });
    return info;
  }

  async setZone(id, { on, setpoint }) {
    if (on !== undefined) await this.patch(id, 'power', Boolean(on));
    if (setpoint !== undefined) {
      if (!this.status.has(id)) await this.getState();
      const key = this.status.get(id)?.setpointKey || 'setpoint_air_cool';
      await this.patch(id, key, Number(setpoint));
    }
  }

  async setMode(systemId, mode) {
    if (!this.masters) await this.getState();
    const master = this.masters.get(systemId);
    if (!master) throw new HttpError(400, 'This group does not allow changing the mode from a zone');
    const available = this.status.get(master)?.status?.mode_available || [];
    // Prefer the plain code (e.g. 2 for cool); fall back to whatever variant the system offers.
    const code = available.find((c) => MODE_TO_NAME[c] === mode && [0, 1, 2, 3, 4, 5].includes(c))
      ?? available.find((c) => MODE_TO_NAME[c] === mode);
    if (code === undefined) throw new HttpError(400, `Mode ${mode} is not available on this system`);
    await this.patch(master, 'mode', code);
  }
}
