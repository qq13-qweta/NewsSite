const $ = (sel, root = document) => root.querySelector(sel);
const POLL_MS = 10_000;
const SETPOINT_DEBOUNCE_MS = 700;
const OVERRIDE_MS = 8_000; // how long optimistic changes win over (possibly stale) polled data

const MODE_INFO = {
  stop: { label: 'Stop', icon: '⏹' },
  cool: { label: 'Cool', icon: '❄️' },
  heat: { label: 'Heat', icon: '🔥' },
  fan: { label: 'Fan', icon: '🌀' },
  dry: { label: 'Dry', icon: '💧' },
  auto: { label: 'Auto', icon: '✨' },
};

let state = null;
const overrides = new Map(); // key → { patch, until }
const setpointTimers = new Map();
let pollTimer = null;

// ---------- API ----------

async function api(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  const pin = localStorage.getItem('aircon-pin');
  if (pin) headers['X-Pin'] = pin;
  const res = await fetch(`api/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (res.status === 401 && json.error === 'PIN required') {
    const entered = prompt('Enter PIN');
    if (entered) { localStorage.setItem('aircon-pin', entered); return api(path, body); }
  }
  if (!res.ok) throw new Error(json.error || `Request failed (${res.status})`);
  return json;
}

// ---------- optimistic overrides ----------

function override(key, patch) {
  const prev = overrides.get(key)?.patch || {};
  overrides.set(key, { patch: { ...prev, ...patch }, until: Date.now() + OVERRIDE_MS });
}

function view() {
  if (!state) return null;
  const now = Date.now();
  for (const [k, o] of overrides) if (o.until < now) overrides.delete(k);
  return {
    ...state,
    systems: state.systems.map((s) => ({
      ...s,
      ...(overrides.get(`sys:${s.id}`)?.patch || {}),
      zones: s.zones.map((z) => ({ ...z, ...(overrides.get(`zone:${z.id}`)?.patch || {}), busy: overrides.has(`zone:${z.id}`) })),
    })),
  };
}

// Drop overrides the device has already caught up with.
function reconcile() {
  for (const s of state.systems) {
    const so = overrides.get(`sys:${s.id}`);
    if (so && so.patch.mode === s.mode) overrides.delete(`sys:${s.id}`);
    for (const z of s.zones) {
      const key = `zone:${z.id}`;
      const o = overrides.get(key);
      if (!o || setpointTimers.has(z.id)) continue;
      if (Object.entries(o.patch).every(([k, v]) => z[k] === v)) overrides.delete(key);
    }
  }
}

// ---------- data ----------

async function refresh() {
  clearTimeout(pollTimer);
  try {
    state = await api('state');
    reconcile();
    setStatus(state.warning ? `⚠ ${state.warning}` : state.label, Boolean(state.warning));
  } catch (err) {
    setStatus(err.message, true);
  }
  render();
  pollTimer = setTimeout(refresh, POLL_MS);
}

const refreshSoon = (ms = 1200) => { clearTimeout(pollTimer); pollTimer = setTimeout(refresh, ms); };

async function command(path, body, rollbackKeys = []) {
  try {
    await api(path, body);
    refreshSoon();
  } catch (err) {
    rollbackKeys.forEach((k) => overrides.delete(k));
    toast(err.message);
    render();
  }
}

function setPower(zone, on) {
  override(`zone:${zone.id}`, { on });
  render();
  command(`zones/${encodeURIComponent(zone.id)}`, { on }, [`zone:${zone.id}`]);
}

function nudgeSetpoint(zone, dir) {
  const current = view().systems.flatMap((s) => s.zones).find((z) => z.id === zone.id);
  const base = current.setpoint ?? Math.round((current.min + current.max) / 2);
  const next = Math.min(current.max, Math.max(current.min, Math.round((base + dir * current.step) / current.step) * current.step));
  override(`zone:${zone.id}`, { setpoint: next });
  render();
  clearTimeout(setpointTimers.get(zone.id));
  setpointTimers.set(zone.id, setTimeout(() => {
    setpointTimers.delete(zone.id);
    command(`zones/${encodeURIComponent(zone.id)}`, { setpoint: next }, [`zone:${zone.id}`]);
  }, SETPOINT_DEBOUNCE_MS));
}

function setMode(system, mode) {
  override(`sys:${system.id}`, { mode });
  render();
  command(`systems/${encodeURIComponent(system.id)}/mode`, { mode }, [`sys:${system.id}`]);
}

function setSystemPower(system, on) {
  for (const z of system.zones) override(`zone:${z.id}`, { on });
  render();
  command(`systems/${encodeURIComponent(system.id)}/power`, { on }, system.zones.map((z) => `zone:${z.id}`));
}

// ---------- rendering ----------

const fmt = (n, digits = 1) => (n === null || n === undefined ? '–' : n.toFixed(digits));
const tone = (mode) => (mode === 'cool' ? 'cool' : mode === 'heat' ? 'heat' : 'other');

function render() {
  const v = view();
  const root = $('#systems');
  if (!v) return;
  if (!v.systems.length) {
    root.innerHTML = '<div class="empty"><p>No zones found.</p><button class="btn primary">Open settings</button></div>';
    $('button', root).onclick = openSettings;
    return;
  }
  root.replaceChildren(...v.systems.map(renderSystem));
}

function renderSystem(s) {
  const el = document.createElement('section');
  el.className = 'system';

  const head = document.createElement('div');
  head.className = 'sys-head';
  head.innerHTML = `<h2></h2><div class="sys-power"><button class="pill" data-on="0">All off</button><button class="pill" data-on="1">All on</button></div>`;
  $('h2', head).textContent = s.name;
  head.querySelectorAll('.pill').forEach((b) => { b.onclick = () => setSystemPower(s, b.dataset.on === '1'); });
  el.append(head);

  if (s.modes.length) {
    const modes = document.createElement('div');
    modes.className = 'modes';
    modes.setAttribute('role', 'group');
    modes.setAttribute('aria-label', 'Mode');
    for (const m of s.modes) {
      const b = document.createElement('button');
      b.className = 'mode';
      b.setAttribute('aria-pressed', String(s.mode === m));
      b.innerHTML = `<span aria-hidden="true">${MODE_INFO[m].icon}</span>${MODE_INFO[m].label}`;
      b.onclick = () => s.mode !== m && setMode(s, m);
      modes.append(b);
    }
    el.append(modes);
  }

  const grid = document.createElement('div');
  grid.className = 'zones';
  for (const z of s.zones) grid.append(renderZone(z, s.mode));
  el.append(grid);
  return el;
}

function renderZone(z, mode) {
  const node = $('#zoneTpl').content.firstElementChild.cloneNode(true);
  const running = z.on && mode !== 'stop';
  node.classList.toggle('on', z.on);
  node.classList.add(tone(mode));
  node.classList.toggle('busy', z.busy);
  node.classList.toggle('offline', Boolean(z.offline));
  $('.zone-name', node).textContent = z.name + (z.offline ? ' (offline)' : '');
  $('.temp', node).textContent = `${fmt(z.temp)}°`;
  $('.hum', node).textContent = z.humidity !== null ? `💧 ${Math.round(z.humidity)}%` : '';
  $('.sp-val', node).textContent = `${fmt(z.setpoint, z.step < 1 ? 1 : 0)}°${z.units === 'F' ? 'F' : ''}`;

  const power = $('.power', node);
  power.setAttribute('aria-pressed', String(z.on));
  power.setAttribute('aria-label', `${z.name}: turn ${z.on ? 'off' : 'on'}`);
  power.onclick = () => setPower(z, !z.on);

  const minus = $('.minus', node);
  const plus = $('.plus', node);
  minus.disabled = z.setpoint !== null && z.setpoint <= z.min;
  plus.disabled = z.setpoint !== null && z.setpoint >= z.max;
  minus.onclick = () => nudgeSetpoint(z, -1);
  plus.onclick = () => nudgeSetpoint(z, +1);

  if (z.on && !running) $('.hum', node).textContent += ' · system stopped';
  return node;
}

function setStatus(text, isError = false) {
  const el = $('#status');
  el.textContent = text;
  el.classList.toggle('err', isError);
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4000);
}

// ---------- settings ----------

const dialog = $('#settings');
const form = $('#settingsForm');

function showModeFields() {
  const mode = form.mode.value || 'demo';
  form.querySelectorAll('[data-for]').forEach((el) => { el.hidden = el.dataset.for !== mode; });
}

async function openSettings() {
  $('#settingsError').hidden = true;
  $('#found').replaceChildren();
  try {
    const cfg = await api('config');
    form.mode.value = cfg.mode;
    form.host.value = cfg.host;
    form.port.value = cfg.port;
    form.email.value = cfg.email;
    form.password.value = '';
    form.password.placeholder = cfg.hasPassword ? 'Saved — leave blank to keep' : '';
  } catch (err) {
    toast(err.message);
  }
  showModeFields();
  dialog.showModal();
}

$('#settingsBtn').onclick = openSettings;
$('#cancelBtn').onclick = () => dialog.close();
$('#modePick').onchange = showModeFields;

form.onsubmit = async (e) => {
  e.preventDefault();
  const btn = $('#saveBtn');
  const err = $('#settingsError');
  btn.disabled = true;
  btn.textContent = 'Connecting…';
  err.hidden = true;
  try {
    await api('config', {
      mode: form.mode.value, host: form.host.value, port: form.port.value,
      email: form.email.value, password: form.password.value,
    });
    overrides.clear();
    dialog.close();
    toast('Connected ✓');
    refresh();
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & connect';
  }
};

$('#discoverBtn').onclick = async () => {
  const btn = $('#discoverBtn');
  const list = $('#found');
  btn.disabled = true;
  btn.textContent = 'Scanning… (up to ~20s)';
  list.replaceChildren();
  try {
    const { found, subnets } = await api('discover', {});
    if (!found.length) {
      list.innerHTML = `<li class="note">Nothing found on ${subnets.map((s) => `${s}.x`).join(', ') || 'this network'}. Check the Local API is enabled, or type the IP from your router.</li>`;
    }
    for (const f of found) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = `Use ${f.host}${f.type ? ` · ${f.type}` : ''}`;
      b.onclick = () => { form.host.value = f.host; form.port.value = f.port; };
      li.append(b);
      list.append(li);
    }
    if (found.length === 1) { form.host.value = found[0].host; form.port.value = found[0].port; }
  } catch (ex) {
    list.innerHTML = '';
    toast(ex.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Find it on my network';
  }
};

// ---------- boot ----------

document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
refresh();
