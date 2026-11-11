// Finds Airzone Webservers on the local network by probing port 3000 on every address
// of each local /24 subnet. Run directly with `npm run discover`, or via the app's settings screen.
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { fetchJson } from './model.js';

function probePort(host, port, timeout) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeout, () => done(false));
    sock.once('connect', () => done(true));
    sock.once('error', () => done(false));
  });
}

export function localSubnets() {
  const prefixes = new Set();
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const isPrivate = x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168);
      if (isPrivate) prefixes.add(a.address.split('.').slice(0, 3).join('.'));
    }
  }
  return [...prefixes];
}

export async function discover({ port = 3000, timeout = 600, concurrency = 64, subnets = localSubnets() } = {}) {
  const hosts = subnets.flatMap((p) => Array.from({ length: 254 }, (_, i) => `${p}.${i + 1}`));
  const open = [];
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < hosts.length) {
      const h = hosts[next++];
      if (await probePort(h, port, timeout)) open.push(h);
    }
  }));
  const found = [];
  for (const host of open) {
    try {
      const info = await fetchJson(`http://${host}:${port}/api/v1/webserver`, { timeout: 2000 }).catch(() => null);
      const hvac = await fetchJson(`http://${host}:${port}/api/v1/hvac`, {
        method: 'POST', body: { systemID: 127, zoneID: 0 }, timeout: 2000,
      }).catch(() => null);
      if (info || hvac) found.push({ host, port, mac: info?.mac ?? null, type: info?.ws_type ?? null });
    } catch { /* not an Airzone device */ }
  }
  return { subnets, found };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { subnets, found } = await discover();
  console.log(`Scanned ${subnets.map((s) => `${s}.0/24`).join(', ') || '(no private networks found)'}`);
  if (!found.length) console.log('No Airzone Local API found. Is the Local API enabled on your Webserver?');
  for (const f of found) console.log(`Found Airzone at ${f.host}:${f.port}${f.type ? ` (${f.type})` : ''}`);
}
