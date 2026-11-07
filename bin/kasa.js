#!/usr/bin/env node
import crypto from 'node:crypto';
import { KasaSession, login } from '../src/cloud.js';
import { displayName, getPower, setPower } from '../src/devices.js';
import {
  ALL, devicesFor, groupName, isAll, refreshDevices, resolveDevice, resolveTargets,
} from '../src/targets.js';
import { ask, askHidden } from '../src/prompt.js';
import {
  DATA_DIR, clearConfig, loadConfig, loadDevices, loadGroups, loadServerConfig, saveConfig, saveGroups,
  saveServerConfig,
} from '../src/store.js';
import { hashPin, localAddresses, startServer } from '../src/server.js';

const HELP = `KasaKontroller - control Kasa switches in groups via the TP-Link cloud

Usage: kasa <command> [args]

  login                          Sign in and save credentials (supports 2FA)
  logout                         Forget saved credentials
  devices                        List devices / strip outlets with on/off state

  groups                         List groups and their members
  group create <name> <dev>...   Create (or replace) a group
  group add <name> <dev>...      Add devices to a group
  group remove <name> <dev>...   Remove devices from a group
  group delete <name>            Delete a group

  on <group|device>...           Turn groups or devices on
  off <group|device>...          Turn groups or devices off
  status [group|device]...       Show current state (all groups if none given)

  <group|device> on|off|status   Same as above, target first: kasa all on

  serve [--port 8080] [--host 0.0.0.0] [--set-pin]
                                 Run the phone web page + API (asks for a PIN first time)

The built-in group "all" is every device and outlet on the account.
Names are case-insensitive; quote names with spaces, e.g. "Living Room".
Strip outlets can be named by outlet alias or as "Strip Name / Outlet Name".
Data is stored in ${DATA_DIR}`;

const promptMfa = async () => {
  console.log('Two-factor authentication is on: TP-Link has emailed you a verification code.');
  return ask('Verification code: ');
};

async function interactiveLogin(existing) {
  if (!process.stdin.isTTY) throw new Error('Not signed in - run "kasa login" in a terminal first');
  const def = existing?.email;
  const email = (await ask(`TP-Link / Kasa account email${def ? ` [${def}]` : ''}: `)) || def;
  if (!email) throw new Error('Email is required');
  const password = await askHidden('Password: ');
  const termId = existing?.termId || crypto.randomUUID();
  const tokens = await login({ email, password, termId, promptMfa });
  const state = { email, password, termId, ...tokens };
  saveConfig(state);
  console.log(`Signed in as ${email}. Credentials saved.`);
  return state;
}

async function getSession() {
  let state = loadConfig();
  if (!state?.email) {
    console.log('No saved credentials - first-time setup.');
    state = await interactiveLogin(state);
  }
  return new KasaSession(state, { onChange: saveConfig, promptMfa: process.stdin.isTTY ? promptMfa : null });
}

const fmtState = (on) => (on === true ? 'ON' : on === false ? 'off' : '?');

function printTable(rows) {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => String(r[i]).length)));
  for (const r of rows) console.log(r.map((c, i) => String(c).padEnd(widths[i])).join('  ').trimEnd());
}

const commands = {
  async login() {
    const state = await interactiveLogin(loadConfig());
    const session = new KasaSession(state, { onChange: saveConfig, promptMfa });
    const devices = await refreshDevices(session);
    console.log(`Found ${devices.length} device(s)/outlet(s). Run "kasa devices" to list them.`);
  },

  async logout() {
    clearConfig();
    console.log('Saved credentials removed.');
  },

  async devices() {
    const session = await getSession();
    const devices = await refreshDevices(session);
    if (!devices.length) return console.log('No devices on this account.');
    printTable([
      ['NAME', 'STATE', 'MODEL', 'ONLINE'],
      ...devices.map((d) => [displayName(d), fmtState(d.on), d.model, d.online ? 'yes' : 'NO']),
    ]);
  },

  async groups() {
    const groups = loadGroups();
    const devices = loadDevices();
    const names = Object.keys(groups);
    console.log(`${ALL}: every device on the account (${devices.length} cached)`);
    if (!names.length) return console.log('No other groups yet. Create one with: kasa group create <name> <device>...');
    for (const g of names) {
      const members = groups[g].map((k) => {
        const d = devices.find((x) => x.key === k);
        return d ? displayName(d) : `${k} (missing)`;
      });
      console.log(`${g}: ${members.join(', ') || '(empty)'}`);
    }
  },

  async group(sub, name, ...refs) {
    if (!sub || !name) throw new Error('Usage: kasa group <create|add|remove|delete> <name> [device...]');
    if (isAll(name)) throw new Error(`"${ALL}" is a built-in group and can't be changed`);
    const groups = loadGroups();
    const existing = groupName(groups, name);

    if (sub === 'delete') {
      if (!existing) throw new Error(`No group named "${name}"`);
      delete groups[existing];
      saveGroups(groups);
      return console.log(`Deleted group "${existing}".`);
    }
    if (!['create', 'add', 'remove'].includes(sub)) throw new Error(`Unknown group command "${sub}"`);
    if (!refs.length) throw new Error(`Usage: kasa group ${sub} <name> <device>...`);
    if (sub !== 'create' && !existing) throw new Error(`No group named "${name}"`);

    const session = await getSession();
    const devices = await devicesFor(session, refs);
    const keys = refs.map((r) => resolveDevice(devices, r).key);
    const key = existing || name;

    if (sub === 'create') {
      if (existing && existing !== name) delete groups[existing];
      groups[name] = [...new Set(keys)];
    } else if (sub === 'add') {
      groups[key] = [...new Set([...groups[key], ...keys])];
    } else {
      groups[key] = groups[key].filter((k) => !keys.includes(k));
    }
    saveGroups(groups);
    await commands.groups();
  },

  async serve(...args) {
    const opt = (name, def) => {
      const i = args.indexOf(`--${name}`);
      return i >= 0 && args[i + 1] ? args[i + 1] : def;
    };
    const port = Number(opt('port', 8080));
    const host = opt('host', '0.0.0.0');

    const cfg = loadServerConfig();
    if (!cfg.pin || args.includes('--set-pin')) {
      if (!process.stdin.isTTY) throw new Error('Set a PIN first: run "kasa serve --set-pin" in a terminal');
      console.log('Choose a PIN for the web page (at least 4 characters). Phones will ask for it once.');
      const pin = (await askHidden('New PIN: ')).trim();
      if (pin.length < 4) throw new Error('PIN must be at least 4 characters');
      if ((await askHidden('Repeat PIN: ')).trim() !== pin) throw new Error('PINs did not match');
      cfg.pin = hashPin(pin);
      saveServerConfig(cfg);
      console.log('PIN saved.');
    }

    await startServer({ port, host, pin: cfg.pin });
    console.log(`Kasa web control running on port ${port}. Open on your phone:`);
    for (const a of localAddresses()) console.log(`  http://${a.address}:${port}   (${a.label})`);
    console.log('Press Ctrl+C to stop.');
  },

  async on(...refs) { await power(refs, true); },
  async off(...refs) { await power(refs, false); },

  async status(...refs) {
    const groups = loadGroups();
    if (!refs.length) refs = Object.keys(groups);
    if (!refs.length) return commands.devices();
    const session = await getSession();
    const devices = await devicesFor(session, refs);
    const targets = resolveTargets(devices, groups, refs);
    const results = await getPower(session, targets);
    printTable([
      ['NAME', 'STATE', ''],
      ...results.map((r) => [displayName(r.entry), fmtState(r.on), r.error || '']),
    ]);
  },
};

async function power(refs, on) {
  if (!refs.length) throw new Error(`Usage: kasa ${on ? 'on' : 'off'} <group|device>...`);
  const session = await getSession();
  const devices = await devicesFor(session, refs);
  const targets = resolveTargets(devices, loadGroups(), refs);
  if (!targets.length) throw new Error('Nothing to switch (empty group?)');
  const results = await setPower(session, targets, on);
  for (const r of results) {
    console.log(`${r.ok ? (on ? 'ON ' : 'off') : 'ERR'}  ${displayName(r.entry)}${r.ok ? '' : `  - ${r.error}`}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

let [cmd, ...args] = process.argv.slice(2);
// Allow target-first order: "kasa all on", "kasa "Living Room" off".
if (cmd && !commands[cmd] && ['on', 'off', 'status'].includes(args[0]?.toLowerCase())) {
  [cmd, args] = [args[0].toLowerCase(), [cmd, ...args.slice(1)]];
}
if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || !commands[cmd]) {
  console.log(HELP);
  if (cmd && !commands[cmd] && !['help', '--help', '-h'].includes(cmd)) process.exitCode = 1;
} else {
  commands[cmd](...args).catch((e) => {
    console.error(`Error: ${e.message}`);
    process.exitCode = 1;
  });
}
