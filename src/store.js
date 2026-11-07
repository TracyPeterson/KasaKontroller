// Persistent app data: account config (with encrypted secrets), the cached
// device list, and group definitions. Stored in %APPDATA%\KasaKontroller on
// Windows, ~/.kasakontroller elsewhere, or KASA_HOME if set.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { protect, unprotect } from './secret.js';

export const DATA_DIR = process.env.KASA_HOME
  || (process.env.APPDATA ? join(process.env.APPDATA, 'KasaKontroller') : join(homedir(), '.kasakontroller'));

function readJson(name, fallback) {
  const file = join(DATA_DIR, name);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, 'utf8'));
}

function writeJson(name, value) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

// Returns {email, termId, host, password, token, refreshToken} or null.
export function loadConfig() {
  const cfg = readJson('config.json', null);
  if (!cfg) return null;
  const { secrets, ...pub } = cfg;
  return { ...pub, ...(secrets ? unprotect(secrets, DATA_DIR) : {}) };
}

export function saveConfig({ email, termId, host, password, token, refreshToken }) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeJson('config.json', {
    email, termId, host,
    secrets: protect({ password, token, refreshToken }, DATA_DIR),
  });
}

export function clearConfig() {
  rmSync(join(DATA_DIR, 'config.json'), { force: true });
}

export const loadDevices = () => readJson('devices.json', []);
export const saveDevices = (devices) => writeJson('devices.json', devices);

// Web server settings: {pin: {salt, hash}} - the PIN itself is never stored.
export const loadServerConfig = () => readJson('server.json', {});
export const saveServerConfig = (cfg) => writeJson('server.json', cfg);

// Groups map a display name to a list of device keys.
export const loadGroups = () => readJson('groups.json', {});
export const saveGroups = (groups) => writeJson('groups.json', groups);
