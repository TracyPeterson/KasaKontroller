# KasaKontroller

Turn TP-Link Kasa smart plugs, switches and power-strip outlets on and off in
named groups through the TP-Link cloud. It works without being on the same
network as the devices. No dependencies; requires Node.js 18+.

## Setup

```sh
npm link          # optional: makes the `kasa` command available everywhere
kasa login        # or: node bin/kasa.js login
```

On first run, the app asks for your TP-Link/Kasa account email and password. If
two-factor authentication is on, TP-Link emails you a code to enter. Later
runs load the saved credentials and sign in by themselves.

## Usage

```sh
kasa devices                                   # list devices + outlets with state
kasa group create "Living Room" "Floor Lamp" "TV Strip / Outlet 2"
kasa group add "Living Room" "Fan"
kasa on "Living Room"
kasa off "Living Room" "Porch Light"           # groups and devices can be mixed
kasa all on                                    # built-in group: every device on the account
kasa all off                                   # (target-first order works for any group/device)
kasa status                                    # state of every group
kasa groups
kasa group delete "Living Room"
```

- Names are case-insensitive. If two outlets share a name, use
  `"Strip Name / Outlet Name"`.
- Groups store each device's ID, so renaming a device in the Kasa app doesn't
  break a group.
- Devices in a group are switched in parallel. Outlets on the same strip are
  switched with a single command. If one device is offline, the rest still
  switch, and the command exits with code 1.

## Control from a phone (`kasa serve`)

```sh
kasa serve                 # first run asks you to choose a PIN
kasa serve --port 9000     # other options: --host <ip>, --set-pin (change PIN)
```

This runs a small web server on this computer. It serves a phone-friendly page
with On/Off buttons for every group (including **All devices**) and a switch
for each device. The console prints the addresses to open. The page asks for
the PIN once and then remembers it on that phone.

**From anywhere with Tailscale:** install [Tailscale](https://tailscale.com)
on this computer and on the phone, signed in to the same account. Then open
`http://<computer's 100.x.x.x Tailscale IP>:8080`, or
`http://<computer-name>:8080` with MagicDNS. Traffic between your devices is
encrypted by Tailscale. Don't forward the port on your router instead.

The first time `kasa serve` runs, Windows Firewall asks whether to allow
Node.js. Allow it, or the phone won't be able to connect. The computer has to
stay on and awake for the page to work.

### iPhone

- **Home-screen app:** open the page in Safari, then **Share → Add to Home
  Screen**. It opens full-screen like an app.
- **Siri / one-tap Shortcuts:** in the Shortcuts app, create a new shortcut:
  1. Add **Get Contents of URL** with the URL
     `http://<tailscale-ip>:8080/api/all/off?format=text`.
  2. Under **Show More**, set **Method** to `POST` and add the header
     `Authorization` with the value `Bearer <your PIN>`.
  3. Add **Show Result** (or **Speak Text**) so you hear the outcome, e.g.
     "all off: 42 of 42 switched."
  4. Name it "All Off". Saying "Hey Siri, All Off" now runs it, and it can be
     added to the home screen or a widget.

  Use the same pattern for any group, e.g. `/api/Social%20Lounge/on`. Keep
  Tailscale connected on the phone; turn on **VPN On Demand** in the Tailscale
  app so it reconnects by itself.

### Android

- **Home-screen app:** open the page in Chrome, then **⋮ → Add to Home screen
  / Install app**.
- **One-tap buttons:** the free **HTTP Shortcuts** app can make home-screen
  buttons with the same POST URL and `Authorization` header as above.

### API

All `/api` requests need the header `Authorization: Bearer <PIN>`. After 5
wrong PINs, that address is blocked for a minute. Add `?format=text` to any
call to get a one-line plain-text reply instead of JSON.

| Request                                   | Does                                    |
| ----------------------------------------- | --------------------------------------- |
| `POST /api/<group or device>/on` / `/off` | Switch it                               |
| `GET /api/<group or device>/status`       | Current state, e.g. "Social Bar: 2 on, 0 off." |
| `GET /api/state` (`?cached=1` for instant) | All devices and groups with state       |

## Where data is stored

`%APPDATA%\KasaKontroller` on Windows, `~/.kasakontroller` elsewhere. Set
`KASA_HOME` to use a different folder.

| File           | Contents                                                     |
| -------------- | ------------------------------------------------------------ |
| `config.json`  | Email, terminal ID, region host, plus encrypted password and tokens |
| `devices.json` | Cached device list (refreshed by `kasa devices`)             |
| `groups.json`  | Group definitions                                            |
| `server.json`  | Salted hash of the web PIN (the PIN itself isn't stored)     |

On Windows the password and tokens are encrypted with DPAPI. Only your Windows
user account on this machine can decrypt them. On other platforms they use
AES-256-GCM with a key file in the same folder, which keeps them out of plain
sight but is not strong protection. `kasa logout` deletes the saved
credentials.

## How it talks to the cloud

TP-Link's cloud API is undocumented. This app follows the Kasa Android app's
V2 protocol, as reverse-engineered by
[piekstra/tplink-cloud-api](https://github.com/piekstra/tplink-cloud-api):

1. Requests are signed with HMAC-SHA1 using app-level keys.
2. The app logs in on the account's regional host.
3. Device commands are sent as `passthrough` requests to each device's
   `appServerUrl`.

The TP-Link servers use a private CA, so its chain is bundled in `certs/`.
Expired tokens are refreshed automatically, and if the refresh fails the app
logs in again with the saved password.

Set `KASA_DEBUG=1` to print the raw cloud responses.

The device commands inside a passthrough (`system.set_relay_state`,
`system.get_sysinfo`) are the same JSON that
[python-kasa](https://github.com/python-kasa/python-kasa) sends to devices on
the local network.
