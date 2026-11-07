// TP-Link Kasa cloud client (V2 signed API).
//
// Protocol details follow the Kasa Android app as documented by
// piekstra/tplink-cloud-api: requests are HMAC-SHA1 signed with app-level
// keys, auth goes to a regional host, and device commands are sent as
// "passthrough" requests to each device's appServerUrl.

import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';

const DEFAULT_HOST = 'https://n-wap.tplinkcloud.com';
const APP_TYPE = 'Kasa_Android_Mix';
const APP_VER = '3.4.451';

// App-level signing keys from the Kasa Android APK (identify the app, not the user).
const ACCESS_KEY = 'e37525375f8845999bcc56d5e6faa76d';
const SECRET_KEY = '314bc6700b3140ca80bc655e527cb062';
const SIGNING_TIMESTAMP = '9999999999';

const PATH_ACCOUNT_STATUS = '/api/v2/account/getAccountStatusAndUrl';
const PATH_LOGIN = '/api/v2/account/login';
const PATH_REFRESH = '/api/v2/account/refreshToken';
const PATH_MFA_LOGIN = '/api/v2/account/checkMFACodeAndLogin';

export const ERR = {
  WRONG_CREDENTIALS: -20601,
  TOKEN_EXPIRED: -20651,
  REFRESH_EXPIRED: -20655,
  ACCOUNT_LOCKED: -20675,
  MFA_REQUIRED: -20677,
  DEVICE_OFFLINE: -20571,
};

const FRIENDLY = {
  [ERR.WRONG_CREDENTIALS]: 'Incorrect email or password',
  [ERR.ACCOUNT_LOCKED]: 'Account locked (too many failed attempts) - try again later',
  [ERR.DEVICE_OFFLINE]: 'Device is offline',
};

export class CloudError extends Error {
  constructor(code, msg, result) {
    super(FRIENDLY[code] || `${msg || 'Cloud error'} (code ${code})`);
    this.code = code;
    this.result = result;
  }
}

// TP-Link's cloud hosts chain to a private CA, so trust it alongside the system roots.
const tplinkCa = readFileSync(new URL('../certs/tplink-ca-chain.pem', import.meta.url), 'utf8');
const agent = new https.Agent({ ca: [...tls.rootCertificates, tplinkCa], keepAlive: true });

function sign(bodyJson, urlPath) {
  const contentMd5 = crypto.createHash('md5').update(bodyJson, 'utf8').digest('base64');
  const nonce = crypto.randomUUID();
  const sigString = `${contentMd5}\n${SIGNING_TIMESTAMP}\n${nonce}\n${urlPath}`;
  const signature = crypto.createHmac('sha1', SECRET_KEY).update(sigString, 'utf8').digest('hex');
  return {
    'Content-MD5': contentMd5,
    'X-Authorization': `Timestamp=${SIGNING_TIMESTAMP}, Nonce=${nonce}, AccessKey=${ACCESS_KEY}, Signature=${signature}`,
  };
}

function post(host, path, body, { termId, token } = {}) {
  const url = new URL(path, host);
  const params = {
    appName: APP_TYPE, appVer: APP_VER, netType: 'wifi', termID: termId, ospf: 'Android 14',
    brand: 'TPLINK', locale: 'en_US', model: 'Pixel', termName: 'Pixel', termMeta: 'Pixel',
  };
  if (token) params.token = token;
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  const bodyJson = JSON.stringify(body);
  const headers = {
    'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel Build/UP1A)',
    'Content-Type': 'application/json;charset=UTF-8',
    'Content-Length': Buffer.byteLength(bodyJson),
    ...sign(bodyJson, url.pathname),
  };

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: 'POST', agent, headers, timeout: 15000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode} from ${url.host}: ${text.slice(0, 200)}`));
        }
        let json;
        try { json = JSON.parse(text); } catch { return reject(new Error(`Invalid JSON from ${url.host}`)); }
        if (process.env.KASA_DEBUG) console.error(`[debug] ${path} ->`, text);
        if (json.error_code !== 0) return reject(new CloudError(json.error_code, json.msg, json.result));
        // V2 account endpoints report failures inside a "successful" result.
        const r = json.result ?? {};
        if (r.errorCode && Number(r.errorCode) !== 0) return reject(new CloudError(Number(r.errorCode), r.errorMsg, r));
        resolve(r);
      });
    });
    req.on('timeout', () => req.destroy(new Error(`Request to ${url.host} timed out`)));
    req.on('error', reject);
    req.end(bodyJson);
  });
}

// Full username/password login. `promptMfa` is called if the account has
// two-factor auth enabled; TP-Link emails the code when the challenge is issued.
export async function login({ email, password, termId, promptMfa }) {
  let host = DEFAULT_HOST;
  try {
    const status = await post(DEFAULT_HOST, PATH_ACCOUNT_STATUS, { appType: APP_TYPE, cloudUserName: email }, { termId });
    if (status.appServerUrl) host = status.appServerUrl;
  } catch {
    // Fall back to the default host; login will report any real problem.
  }

  let result;
  try {
    result = await post(host, PATH_LOGIN, {
      appType: APP_TYPE,
      appVersion: APP_VER,
      cloudPassword: password,
      cloudUserName: email,
      platform: 'Android',
      refreshTokenNeeded: true,
      supportBindAccount: false,
      terminalUUID: termId,
      terminalName: 'Pixel',
      terminalMeta: 'Pixel',
    }, { termId });
  } catch (e) {
    if (e.code !== ERR.MFA_REQUIRED) throw e;
    if (!promptMfa) throw new Error('Two-factor code required - run "kasa login" interactively');
    const code = await promptMfa(e.result?.mfaType || 'verifyCodeLogin');
    result = await post(host, PATH_MFA_LOGIN, {
      appType: APP_TYPE,
      cloudPassword: password,
      cloudUserName: email,
      code: String(code).trim(),
      terminalUUID: termId,
    }, { termId });
  }

  if (!result.token) throw new Error('Login succeeded but no token was returned');
  return { host, token: result.token, refreshToken: result.refreshToken };
}

// An authenticated session. `state` holds {email, password, termId, host,
// token, refreshToken}; `onChange` is called whenever tokens are renewed so
// they can be persisted.
export class KasaSession {
  constructor(state, { onChange, promptMfa } = {}) {
    this.state = state;
    this.onChange = onChange;
    this.promptMfa = promptMfa;
  }

  // Concurrent requests that hit an expired token share one renewal.
  renew() {
    this.renewing ??= this.doRenew().finally(() => { this.renewing = null; });
    return this.renewing;
  }

  async doRenew() {
    const s = this.state;
    let renewed = null;
    if (s.refreshToken) {
      try {
        const r = await post(s.host, PATH_REFRESH, {
          appType: APP_TYPE, refreshToken: s.refreshToken, terminalUUID: s.termId,
        }, { termId: s.termId });
        if (r.token) renewed = { token: r.token, refreshToken: r.refreshToken || s.refreshToken };
      } catch {
        // Refresh token expired or rejected; fall through to a full login.
      }
    }
    if (!renewed) {
      if (!s.email || !s.password) throw new Error('Session expired - run "kasa login"');
      renewed = await login({ email: s.email, password: s.password, termId: s.termId, promptMfa: this.promptMfa });
    }
    Object.assign(s, renewed);
    if (this.onChange) await this.onChange(s);
  }

  async request(host, body) {
    if (!this.state.token) await this.renew();
    try {
      return await post(host, '/', body, { termId: this.state.termId, token: this.state.token });
    } catch (e) {
      if (e.code !== ERR.TOKEN_EXPIRED) throw e;
      await this.renew();
      return post(host, '/', body, { termId: this.state.termId, token: this.state.token });
    }
  }

  async getDeviceList() {
    const r = await this.request(this.state.host, { method: 'getDeviceList' });
    return r.deviceList || [];
  }

  async passthrough(appServerUrl, deviceId, data) {
    const r = await this.request(appServerUrl || this.state.host, {
      method: 'passthrough',
      params: { deviceId, requestData: JSON.stringify(data) },
    });
    const d = r.responseData;
    return typeof d === 'string' ? JSON.parse(d) : d;
  }
}
