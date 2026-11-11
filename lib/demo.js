// Demo backend: fake zones held in memory so you can try the app without any hardware.
import { HttpError, clamp } from './model.js';

export class DemoBackend {
  constructor() {
    const zone = (id, name, temp, humidity) => ({
      id, name, on: false, temp, humidity, setpoint: 24, min: 15, max: 30, step: 0.5, units: 'C',
    });
    this.state = {
      systems: [{
        id: '1', name: 'Group 1', mode: 'cool', modes: ['stop', 'cool', 'heat', 'fan', 'dry', 'auto'],
        zones: [
          zone('1:1', 'Living room', 21.4, 65),
          zone('1:2', 'Trastero', 21.1, 65),
          zone('1:3', 'Invitados', 21.2, 68),
          zone('1:4', 'Master Bed', 21.8, 63),
        ],
      }],
    };
  }

  get label() { return 'Demo mode (no real aircon)'; }

  async getState() {
    // Drift room temperatures a little towards the setpoint of zones that are on.
    const sys = this.state.systems[0];
    for (const z of sys.zones) {
      if (z.on && sys.mode !== 'stop' && sys.mode !== 'fan') z.temp += Math.sign(z.setpoint - z.temp) * 0.1;
      z.temp = Math.round(z.temp * 10) / 10;
    }
    return structuredClone(this.state);
  }

  async setZone(id, { on, setpoint }) {
    const z = this.state.systems.flatMap((s) => s.zones).find((x) => x.id === id);
    if (!z) throw new HttpError(404, `Unknown zone ${id}`);
    if (on !== undefined) z.on = Boolean(on);
    if (setpoint !== undefined) z.setpoint = clamp(Number(setpoint), z.min, z.max);
  }

  async setMode(systemId, mode) {
    const s = this.state.systems.find((x) => x.id === systemId);
    if (!s) throw new HttpError(404, `Unknown system ${systemId}`);
    if (!s.modes.includes(mode)) throw new HttpError(400, `Mode ${mode} not available`);
    s.mode = mode;
  }
}
