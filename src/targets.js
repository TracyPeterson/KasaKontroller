// Resolving group and device names into devices, shared by the CLI and web server.

import { discoverDevices, displayName, findDevices } from './devices.js';
import { loadDevices, loadGroups, saveDevices } from './store.js';

export async function refreshDevices(session) {
  const devices = await discoverDevices(session, loadDevices());
  saveDevices(devices);
  return devices;
}

// Load cached devices, refreshing from the cloud if the cache is empty or
// any name can't be found in it (new device or renamed).
// "all" always refreshes so it covers every device currently on the account.
export async function devicesFor(session, refs = []) {
  let devices = loadDevices();
  const groups = loadGroups();
  const missing = refs.some((r) => !isAll(r) && !groupName(groups, r) && !findDevices(devices, r).length);
  if (!devices.length || missing || refs.some(isAll)) devices = await refreshDevices(session);
  return devices;
}

export const ALL = 'all';
export const isAll = (ref) => ref.trim().toLowerCase() === ALL;

export const groupName = (groups, ref) => Object.keys(groups).find((g) => g.toLowerCase() === ref.trim().toLowerCase());

export function resolveDevice(devices, ref) {
  const found = findDevices(devices, ref);
  if (!found.length) throw new Error(`No device named "${ref}" (run "kasa devices" to see names)`);
  if (found.length > 1) {
    throw new Error(`"${ref}" matches several devices:\n${found.map((d) => `  ${displayName(d)}  [${d.key}]`).join('\n')}\nUse "Strip / Outlet" or the [key].`);
  }
  return found[0];
}

// Expand group names and device names into a de-duplicated list of devices.
export function resolveTargets(devices, groups, refs) {
  const out = new Map();
  for (const ref of refs) {
    if (isAll(ref)) {
      for (const d of devices) out.set(d.key, d);
      continue;
    }
    const g = groupName(groups, ref);
    if (g) {
      for (const key of groups[g]) {
        const d = devices.find((x) => x.key === key);
        if (d) out.set(key, d);
        else console.warn(`warning: group "${g}" member ${key} no longer exists on the account`);
      }
    } else {
      const d = resolveDevice(devices, ref);
      out.set(d.key, d);
    }
  }
  return [...out.values()];
}
