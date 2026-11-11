// Fake Airzone devices for tests. Shapes follow the real Local API and Airzone Cloud responses.
import http from 'node:http';

function listen(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(async (req, res) => {
      let raw = '';
      for await (const c of req) raw += c;
      const body = raw ? JSON.parse(raw) : {};
      const reply = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      handler(req, body, reply);
    });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// Local API webserver. `broadcast` = whether firmware understands systemID 127.
export async function fakeLocal({ broadcast = true } = {}) {
  const zones = [
    { systemID: 1, zoneID: 1, name: 'Living room', on: 0, roomTemp: 21.4, humidity: 65, setpoint: 24, minTemp: 15, maxTemp: 30, mode: 2, modes: [1, 2, 3, 4, 5], units: 0 },
    { systemID: 1, zoneID: 2, name: 'Trastero', on: 0, roomTemp: 21.1, humidity: 65, setpoint: 24, minTemp: 15, maxTemp: 30, mode: 2, units: 0 },
    { systemID: 1, zoneID: 3, name: 'Invitados', on: 1, roomTemp: 21.2, humidity: 68, setpoint: 23.5, minTemp: 15, maxTemp: 30, mode: 2, units: 0 },
  ];
  const puts = [];
  const { srv, port } = await listen((req, body, reply) => {
    if (req.url !== '/api/v1/hvac') return reply(404, { errors: [{ url: 'not found' }] });
    if (req.method === 'POST') {
      if (body.systemID === 127 && broadcast) return reply(200, { systems: [{ data: zones }] });
      if (body.systemID === 1 && body.zoneID === 0) return reply(200, { data: zones });
      return reply(400, { errors: [{ systemID: 'out of range' }] });
    }
    if (req.method === 'PUT') {
      puts.push(body);
      const z = zones.find((x) => x.systemID === body.systemID && x.zoneID === body.zoneID);
      if (!z) return reply(400, { errors: [{ zoneID: 'out of range' }] });
      if ('mode' in body) {
        if (!z.modes) return reply(400, { errors: [{ mode: 'not master' }] });
        zones.forEach((x) => { x.mode = body.mode; });
      }
      for (const k of ['on', 'setpoint']) if (k in body) z[k] = body[k];
      return reply(200, { data: [{ systemID: z.systemID, zoneID: z.zoneID, ...body }] });
    }
    reply(405, {});
  });
  return { zones, puts, host: '127.0.0.1', port, close: () => srv.close() };
}

// Airzone Cloud API.
export async function fakeCloud() {
  const devices = {
    dz1: { name: 'Living room', power: false, local_temp: { celsius: 21.4, fah: 70 }, humidity: 65, mode: 3, mode_available: [0, 1, 2, 3, 4, 5],
      setpoint_air_cool: { celsius: 24 }, setpoint_air_heat: { celsius: 21 }, range_sp_hot_air_min: { celsius: 15 }, range_sp_hot_air_max: { celsius: 30 }, isConnected: true },
    dz2: { name: 'Master Bed', power: true, local_temp: { celsius: 21.8 }, humidity: 63, mode: 3, mode_available: [],
      setpoint_air_cool: { celsius: 25 }, setpoint_air_heat: { celsius: 22 }, isConnected: true },
  };
  const patches = [];
  let validToken = 'tok1';
  const { srv, port } = await listen((req, body, reply) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace('/api/v1', '');
    if (p === '/auth/login' && req.method === 'POST') {
      return body.password === 'secret' ? reply(200, { token: validToken, refreshToken: 'ref1' }) : reply(401, { msg: 'bad credentials' });
    }
    if (p === '/auth/refreshToken/ref1') return reply(200, { token: validToken, refreshToken: 'ref1' });
    if (req.headers.authorization !== `Bearer ${validToken}`) return reply(401, { msg: 'expired' });
    if (p === '/installations') return reply(200, { installations: [{ installation_id: 'inst1', name: 'Linda nueva' }] });
    if (p === '/installations/inst1') {
      return reply(200, { groups: [{ group_id: 'g1', name: 'Group 1', devices: [
        { device_id: 'dz1', name: 'Living room', type: 'az_zone' },
        { device_id: 'dz2', name: 'Master Bed', type: 'az_zone' },
        { device_id: 'sys1', name: 'System', type: 'az_system' },
      ] }] });
    }
    const m = p.match(/^\/devices\/(\w+)(\/status)?$/);
    if (m && devices[m[1]]) {
      if (url.searchParams.get('installation_id') !== 'inst1' && req.method === 'GET') return reply(400, { msg: 'missing installation' });
      if (req.method === 'GET') return reply(200, devices[m[1]]);
      if (req.method === 'PATCH') {
        patches.push({ device: m[1], ...body });
        const d = devices[m[1]];
        if (body.param === 'mode') Object.values(devices).forEach((x) => { x.mode = body.value; });
        else d[body.param] = typeof d[body.param] === 'object' ? { celsius: body.value } : body.value;
        return reply(200, {});
      }
    }
    reply(404, { msg: 'not found' });
  });
  return {
    devices, patches, baseUrl: `http://127.0.0.1:${port}/api/v1`,
    expireToken: () => { validToken = 'tok2'; },
    close: () => srv.close(),
  };
}
