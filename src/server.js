// `kasa serve`: a small web server with a phone-friendly control page and a
// JSON API (also usable from iOS Shortcuts / Android HTTP shortcut apps).
//
//   GET  /api/state[?cached=1]          devices + groups with on/off state
//   POST /api/<group|device>/on|off     switch; returns per-device results
//   GET  /api/<group|device>/status     current state
//
// Every /api request needs the PIN: "Authorization: Bearer <pin>".
// Add ?format=text to get a one-line plain-text summary (handy for Siri).

import http from 'node:http';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { KasaSession } from './cloud.js';
import { displayName, getPower, setPower } from './devices.js';
import { ALL, devicesFor, refreshDevices, resolveTargets } from './targets.js';
import { loadConfig, loadDevices, loadGroups, saveConfig } from './store.js';

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
  '/icon-180.png': ['icon-180.png', 'image/png'],
  '/icon-512.png': ['icon-512.png', 'image/png'],
};

export function hashPin(pin) {
  const salt = crypto.randomBytes(16);
  return { salt: salt.toString('base64'), hash: crypto.scryptSync(pin, salt, 32).toString('base64') };
}

function pinMatches(pin, stored) {
  const hash = crypto.scryptSync(pin, Buffer.from(stored.salt, 'base64'), 32);
  return crypto.timingSafeEqual(hash, Buffer.from(stored.hash, 'base64'));
}

// After 5 wrong PINs from one address, refuse that address for a minute.
const failures = new Map();
function checkAuth(req, storedPin) {
  const ip = req.socket.remoteAddress;
  const f = failures.get(ip);
  if (f && f.count >= 5 && Date.now() < f.until) return 'locked';
  const pin = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (pin && pinMatches(pin, storedPin)) { failures.delete(ip); return 'ok'; }
  const count = (f && Date.now() < f.until ? f.count : 0) + 1;
  failures.set(ip, { count, until: Date.now() + 60_000 });
  return 'bad';
}

const deviceJson = (d) => ({ key: d.key, name: displayName(d), on: d.on ?? null, online: !!d.online, model: d.model });

function groupsJson(devices) {
  const groups = loadGroups();
  return [
    { name: ALL, builtin: true, keys: devices.map((d) => d.key) },
    ...Object.entries(groups).map(([name, keys]) => ({ name, keys })),
  ];
}

function powerSummary(target, on, results) {
  const ok = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  let s = `${target} ${on ? 'on' : 'off'}: ${ok.length} of ${results.length} switched.`;
  if (failed.length) s += ` Failed: ${failed.map((r) => displayName(r.entry)).join(', ')}.`;
  return s;
}

function statusSummary(target, results) {
  const on = results.filter((r) => r.on === true).length;
  const off = results.filter((r) => r.on === false).length;
  const unknown = results.length - on - off;
  return `${target}: ${on} on, ${off} off${unknown ? `, ${unknown} unreachable` : ''}.`;
}

export function startServer({ port, host, pin }) {
  const config = loadConfig();
  if (!config?.email) throw new Error('Not signed in - run "kasa login" first');
  // No MFA prompt possible here; if a full re-login needs a code, the
  // request fails and the user runs "kasa login" again.
  const session = new KasaSession(config, { onChange: saveConfig });

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    const reply = (status, json, text) => (url.searchParams.get('format') === 'text'
      ? send(status, text ?? json.error ?? '', 'text/plain; charset=utf-8')
      : send(status, json));

    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        return send(200, readFileSync(new URL(`./web/${file}`, import.meta.url)), type);
      }

      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== 'api') return send(404, { error: 'Not found' });

      const auth = checkAuth(req, pin);
      if (auth === 'locked') return reply(429, { error: 'Too many wrong PINs - wait a minute' });
      if (auth === 'bad') return reply(401, { error: 'Wrong PIN' });

      if (parts.length === 2 && parts[1] === 'state' && req.method === 'GET') {
        const devices = url.searchParams.get('cached') ? loadDevices() : await refreshDevices(session);
        return reply(200, { devices: devices.map(deviceJson), groups: groupsJson(devices) });
      }

      if (parts.length === 3) {
        const [, target, action] = parts;
        const devices = await devicesFor(session, [target]);
        const entries = resolveTargets(devices, loadGroups(), [target]);
        if (!entries.length) return reply(400, { error: `"${target}" has no devices` });

        if ((action === 'on' || action === 'off') && req.method === 'POST') {
          const results = await setPower(session, entries, action === 'on');
          const summary = powerSummary(target, action === 'on', results);
          return reply(200, {
            ok: results.every((r) => r.ok),
            summary,
            results: results.map((r) => ({ key: r.entry.key, name: displayName(r.entry), ok: r.ok, error: r.error })),
          }, summary);
        }
        if (action === 'status' && req.method === 'GET') {
          const results = await getPower(session, entries);
          const summary = statusSummary(target, results);
          return reply(200, {
            summary,
            results: results.map((r) => ({ key: r.entry.key, name: displayName(r.entry), on: r.on, error: r.error })),
          }, summary);
        }
      }
      return reply(404, { error: 'Unknown API route' });
    } catch (e) {
      // Bad device/group names are the user's error; everything else is ours.
      const status = /^No device named|matches several devices/.test(e.message) ? 400 : 500;
      return reply(status, { error: e.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(server));
  });
}

// Addresses a phone could use to reach this machine.
export function localAddresses() {
  const out = [];
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      const [x, y] = a.address.split('.').map(Number);
      const tailscale = x === 100 && y >= 64 && y <= 127;
      out.push({ address: a.address, label: tailscale ? 'Tailscale' : name });
    }
  }
  return out;
}
