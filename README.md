# @meiyu/dsh-mobile-bridge

Reach this DeepSeek Harness desktop from the native mobile client over the public
internet, with an address and a password.

## What it does

Three parts, each owned here:

- **Gateway** — projects sessions over the Remote wire (`@deepseek-ai/dsh-mobile-gateway`,
  inlined from the source tree so this package does not depend on that branch).
- **Front** — listens on loopback, answers `POST /v1/auth` with a password, and
  forwards every other route to the gateway.
- **Tunnel** — a Cloudflare quick tunnel gives the front a public address.

The gateway keeps listening on loopback. `/api` in the current release admits only
an authenticated peer, so the gateway's wire client carries the cookie the host
mints from its launch token (`connection.authenticatedUrl`).

## 界面与交互

扫码配对、自定义密码、设备移除的布局与交互说明见 [docs/UI.md](docs/UI.md)。

## Where the values land

`~/.dsh/mobile-bridge/` (owner-only):

| File | Holds |
| --- | --- |
| `password` | The 32-character access password |
| `devices.json` | Paired devices: id, label, creation time, token hash |
| `status.json` | Published public address, password, and front port |

With a named tunnel the address is fixed (`https://<hostname>` routed to your own
tunnel), so it survives restarts. A quick tunnel invents a new
`trycloudflare.com` address every start and is kept only as a fallback.

The address changes on every start, so read `status.json` (or the desktop log)
rather than copying it into the app once.

## Sign in

In the app, enter the hostname and the password. The front answers with the same
`{ deviceId, accessToken }` envelope a pairing code issues, so the stored
connection is identical either way.

There is no pairing page and no QR code: the app's scan button expects a
desktop-minted pairing payload, and minting one needs a settings surface the
desktop client does not expose for this plugin. Address plus password covers the
same need while the hostname is stable.

## Verified against a live host

Run through a real `dsh web` instance on the same machine, through the plugin's
front listener:

| Route | Result |
| --- | --- |
| `POST /v1/auth` | 200 with `{ deviceId, accessToken }`; 401 on a wrong password; 429 after five failures |
| `POST /v1/sessions/list` | 200 with 304 real sessions |
| `POST /v1/sessions/running` | 200 |
| `POST /v1/sessions/:id/models` | 200 |
| `POST /v1/settings/describe` | 200 |
| `GET /v1/events` | 200 SSE stream: `gateway/ready` then heartbeats |

Two routes are still limited:

- **History** — `session/page` requires `throughSeq`, which the gateway reads from
  the `session/follow` opening frame. That frame's cursor field does not map in
  the current release, so the page call is rejected.
- **Search** — the host answers `session search is disabled: this deployment
  configures the session-query…`, so a profile without session-query refuses it.
  That is a deployment setting, not a bridge defect.

## Limits worth knowing

- The public address changes on every restart until a named tunnel with your own
  domain replaces the quick one.
- A free Apple ID's install expires after seven days; that is a signing limit, not
  a bridge limit.
- Five wrong passwords from one address lock it for a minute; forty across all
  addresses pause the endpoint for a minute.
