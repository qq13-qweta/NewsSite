// Shared data model used by every backend, so the UI never cares where data came from.
//
// State shape returned by backend.getState():
// {
//   systems: [{
//     id: string, name: string,
//     mode: ModeName | null,          // current system mode (mode is shared by all zones in a system)
//     modes: ModeName[],              // modes the system supports ([] = cannot change mode)
//     zones: [{
//       id: string, name: string, on: boolean,
//       temp: number | null, humidity: number | null,
//       setpoint: number | null, min: number, max: number, step: number,
//       units: 'C' | 'F'
//     }]
//   }]
// }

export const MODES = ['stop', 'cool', 'heat', 'fan', 'dry', 'auto'];

export function clamp(v, min, max) {
  return Math.min(max, Math.max(min, v));
}

export function roundToStep(v, step) {
  return Math.round(v / step) * step;
}

export function num(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'object') v = v.celsius ?? v.value ?? null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function fetchJson(url, { method = 'GET', body, headers = {}, timeout = 8000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON body */ }
    if (!res.ok) {
      const msg = json?.msg || json?.message || json?.errors?.[0] && JSON.stringify(json.errors[0]) || text || res.statusText;
      throw new HttpError(res.status, `${method} ${url} → ${res.status}: ${String(msg).slice(0, 200)}`);
    }
    return json;
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(504, `Timed out talking to ${new URL(url).host}`);
    if (err instanceof HttpError) throw err;
    throw new HttpError(502, `Could not reach ${new URL(url).host}: ${err.cause?.code || err.message}`);
  } finally {
    clearTimeout(timer);
  }
}
