// Device discovery and control. Power strips (HS300, KP303, KP400, EP40...)
// are expanded into one entry per outlet so outlets can be grouped
// individually. Each entry has a stable `key`: the deviceId for single
// devices, or "deviceId/childId" for strip outlets.

const BULB_TYPE = 'IOT.SMARTBULB';
const BULB_SERVICE = 'smartlife.iot.smartbulb.lightingservice';

// Some firmwares report short child ids ("00"); commands need the full id.
const fullChildId = (parentId, id) => (id.startsWith(parentId) ? id : parentId + id);

async function getSysinfo(session, dev) {
  const r = await session.passthrough(dev.appServerUrl, dev.deviceId, { system: { get_sysinfo: null } });
  const sys = r?.system?.get_sysinfo;
  if (!sys) throw new Error('No response from device');
  if (sys.err_code) throw new Error(sys.err_msg || `Device error ${sys.err_code}`);
  return sys;
}

function stateFromSysinfo(entry, sys) {
  if (entry.childId) {
    const child = (sys.children || []).find((c) => fullChildId(entry.deviceId, c.id) === entry.childId);
    return child ? child.state === 1 : null;
  }
  if (entry.kind === 'bulb') return sys.light_state?.on_off === 1;
  return sys.relay_state === 1;
}

// Fetch the account's devices from the cloud, expanding strips into outlets.
// Includes the current on/off state where the device is reachable.
export async function discoverDevices(session, previous = []) {
  const list = await session.getDeviceList();
  const out = [];

  await Promise.all(list.map(async (d) => {
    const base = {
      deviceId: d.deviceId,
      model: d.deviceModel,
      appServerUrl: d.appServerUrl,
      kind: d.deviceType === BULB_TYPE ? 'bulb' : 'plug',
      online: d.status === 1,
    };
    let sys = null;
    if (base.online) {
      try { sys = await getSysinfo(session, base); } catch { base.online = false; }
    }

    if (sys?.children?.length) {
      for (const c of sys.children) {
        const childId = fullChildId(d.deviceId, c.id);
        out.push({ ...base, key: `${d.deviceId}/${childId}`, childId, name: c.alias, parent: d.alias, on: c.state === 1 });
      }
      return;
    }

    // Strip that's offline right now: keep the outlets we knew about before.
    const knownOutlets = previous.filter((p) => p.deviceId === d.deviceId && p.childId);
    if (!sys && knownOutlets.length) {
      for (const p of knownOutlets) out.push({ ...p, ...base, parent: d.alias, on: null });
      return;
    }

    const entry = { ...base, key: d.deviceId, childId: null, name: d.alias, parent: null };
    entry.on = sys ? stateFromSysinfo(entry, sys) : null;
    out.push(entry);
  }));

  return out.sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

export const displayName = (e) => (e.parent ? `${e.parent} / ${e.name}` : e.name);

// Find devices matching a user-supplied name: exact key, alias, or
// "Strip / Outlet". Case-insensitive.
export function findDevices(devices, ref) {
  const r = ref.trim().toLowerCase();
  const norm = (s) => s.toLowerCase().replace(/\s*\/\s*/g, '/');
  const byKey = devices.filter((d) => d.key.toLowerCase() === r);
  if (byKey.length) return byKey;
  return devices.filter((d) => d.name.toLowerCase() === r || (d.parent && norm(displayName(d)) === norm(r)));
}

// Group entries by physical device so each strip gets a single command.
function byPhysicalDevice(entries) {
  const map = new Map();
  for (const e of entries) {
    if (!map.has(e.deviceId)) map.set(e.deviceId, []);
    map.get(e.deviceId).push(e);
  }
  return [...map.values()];
}

// Turn entries on/off. Returns [{entry, ok, error}] - one failing device
// doesn't stop the rest.
export async function setPower(session, entries, on) {
  const state = on ? 1 : 0;
  const results = await Promise.all(byPhysicalDevice(entries).map(async (group) => {
    const dev = group[0];
    try {
      let req;
      if (dev.kind === 'bulb') {
        req = { [BULB_SERVICE]: { transition_light_state: { on_off: state } } };
      } else {
        req = { system: { set_relay_state: { state } } };
        const childIds = group.map((e) => e.childId).filter(Boolean);
        if (childIds.length) req.context = { child_ids: childIds };
      }
      const r = await session.passthrough(dev.appServerUrl, dev.deviceId, req);
      const sub = dev.kind === 'bulb' ? r?.[BULB_SERVICE]?.transition_light_state : r?.system?.set_relay_state;
      if (!sub) throw new Error('No response from device');
      if (sub.err_code) throw new Error(sub.err_msg || `Device error ${sub.err_code}`);
      return group.map((entry) => ({ entry, ok: true }));
    } catch (e) {
      return group.map((entry) => ({ entry, ok: false, error: e.message }));
    }
  }));
  return results.flat();
}

// Read current state. Returns [{entry, on, error}].
export async function getPower(session, entries) {
  const results = await Promise.all(byPhysicalDevice(entries).map(async (group) => {
    try {
      const sys = await getSysinfo(session, group[0]);
      return group.map((entry) => ({ entry, on: stateFromSysinfo(entry, sys) }));
    } catch (e) {
      return group.map((entry) => ({ entry, on: null, error: e.message }));
    }
  }));
  return results.flat();
}
