// Encrypts the saved password and tokens at rest.
//
// On Windows this uses DPAPI (CurrentUser scope) via PowerShell, so the data
// can only be decrypted by the same Windows user on the same machine.
// Elsewhere it falls back to AES-256-GCM with a key file stored beside the
// config (readable only by the owner) - this protects against casual reading
// of config.json, not against someone with full access to your account.

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DPAPI_SCRIPT = (mode) => `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Security
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$b = [Convert]::FromBase64String([Console]::In.ReadToEnd().Trim())
$r = [System.Security.Cryptography.ProtectedData]::${mode}($b, $null, $scope)
[Console]::Out.Write([Convert]::ToBase64String($r))
`;

function dpapi(mode, base64) {
  const encoded = Buffer.from(DPAPI_SCRIPT(mode), 'utf16le').toString('base64');
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    input: base64,
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function aesKey(dir) {
  const file = join(dir, '.key');
  if (!existsSync(file)) writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
  return Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
}

export function protect(obj, dir) {
  const plain = Buffer.from(JSON.stringify(obj), 'utf8');
  if (process.platform === 'win32') {
    return { scheme: 'dpapi', data: dpapi('Protect', plain.toString('base64')) };
  }
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey(dir), iv);
  const data = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    scheme: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  };
}

export function unprotect(blob, dir) {
  let plain;
  if (blob.scheme === 'dpapi') {
    plain = Buffer.from(dpapi('Unprotect', blob.data), 'base64');
  } else if (blob.scheme === 'aes-256-gcm') {
    const decipher = crypto.createDecipheriv('aes-256-gcm', aesKey(dir), Buffer.from(blob.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
    plain = Buffer.concat([decipher.update(Buffer.from(blob.data, 'base64')), decipher.final()]);
  } else {
    throw new Error(`Unknown secret scheme: ${blob.scheme}`);
  }
  return JSON.parse(plain.toString('utf8'));
}
