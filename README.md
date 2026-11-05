# dsh-phone-access

Reach this DeepSeek Harness desktop from the native mobile client — over the local
network, a public tunnel, or both. A phone pairs by scanning a QR code and never
types an address or a password.

## What it does

Four parts, each owned here:

- **Gateway** — projects sessions over the Remote wire (`@deepseek-ai/dsh-mobile-gateway`,
  inlined from the source tree so this package does not depend on that branch).
- **Front** — listens on loopback, answers `POST /v1/auth` with a password and
  `POST /v1/pairing/redeem` with a one-time code, and forwards every other route to
  the gateway.
- **Tunnel** — a Cloudflare tunnel gives the front a public address: named (fixed
  hostname) or quick (a fresh `trycloudflare.com` address per start).
- **Section** — a Settings page showing the pairing QR, the credentials, the
  connection choices, and the paired devices.

The gateway keeps listening on loopback. `/api` in the current release admits only
an authenticated peer, so the gateway's wire client carries the cookie the host
mints from its launch token (`connection.authenticatedUrl`).

## 界面与交互

扫码配对、自定义密码、设备移除、连接方式的布局与交互说明见 [docs/UI.md](docs/UI.md)。

## Choices

Which paths a phone may use is a decision, not a build-time constant. The section
writes it to `~/.dsh/mobile-bridge/settings.json`:

| Key          | Values                    | Effect                                                       |
| ------------ | ------------------------- | ------------------------------------------------------------ |
| `lan`        | `true` / `false`          | Bind the front to `0.0.0.0` so the same network can reach it |
| `tunnel`     | `named` / `quick` / `off` | Which public tunnel runs                                     |
| `tunnelName` | string                    | `cloudflared tunnel create` name, for `named`                |
| `hostname`   | string                    | Public hostname routed to the named tunnel                   |

**A saved choice wins over `cordis.patch.yml`.** The packaged config supplies the
defaults a fresh install starts from; once the section saves, that file no longer
decides these four keys. Editing `cordis.patch.yml` for `lan`/`tunnel` therefore
appears to do nothing until `settings.json` is deleted.

Applying a change rebinds the front (when `lan` changes) and restarts the tunnel
(when the mode changes), without restarting the desktop application.

## Where the values land

`~/.dsh/mobile-bridge/` (owner-only):

| File             | Holds                                                                          |
| ---------------- | ------------------------------------------------------------------------------ |
| `password`       | The access password: 32 random characters, or one the operator typed           |
| `devices.json`   | Paired devices: id, label, creation time, token hash                           |
| `status.json`    | Published public and LAN addresses, password, front port, last tunnel error    |
| `settings.json`  | The choices above; absent until the section saves once                         |
| `public-url.txt` | Only when `publicUrlFile` names it: an address published by an external tunnel |

The address changes on every start of a quick tunnel, so read `status.json` (or the
desktop log) rather than copying it into the app once. A named tunnel keeps its
hostname across restarts.

## Pairing

Two ways, both ending in the same durable device credential:

1. **Scan** — the section mints a one-time secret and draws it as a QR code. The
   app reads `{ version, gatewayUrl, pairingId, pairingSecret, expiresAt }` and
   posts it to `/v1/pairing/redeem`. Codes expire in five minutes and work once.
2. **Type** — enter the address and password; `POST /v1/auth` answers with the same
   `{ deviceId, accessToken }` envelope.

## Security

| Layer        | What it does                                                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Transport    | Cloudflare terminates TLS; the tunnel reaches the front over loopback                                                                                                                                                          |
| Entry        | Only `POST /v1/auth` and `/v1/pairing/redeem` are reachable without a credential; everything else needs a device bearer token                                                                                                  |
| Password     | Constant-time compare; a requested password must be 16–128 characters with no whitespace                                                                                                                                       |
| Pairing code | Five-minute TTL, single use, hashed at rest                                                                                                                                                                                    |
| Rate limit   | Five failures per client lock that client for a minute; forty across all clients pause the endpoint for a minute. The client key comes from `cf-connecting-ip` **only when the peer is loopback** — a LAN peer cannot spoof it |
| Devices      | Removing a device revokes its token before the record leaves the list                                                                                                                                                          |
| Exposure     | `lan: false` keeps the front on loopback, so the tunnel is the only entry point                                                                                                                                                |

The global failure counter can pause the endpoint for everyone, including the
owner, for up to a minute. An already-paired phone is unaffected: its bearer token
does not pass through `/v1/auth`.

## Verified against a live host

Run through a real `dsh web` instance on the same machine, through the plugin's
front listener:

| Route                          | Result                                                                                 |
| ------------------------------ | -------------------------------------------------------------------------------------- |
| `POST /v1/auth`                | 200 with `{ deviceId, accessToken }`; 401 on a wrong password; 429 after five failures |
| `POST /v1/pairing/redeem`      | 200 on a fresh code; the same code fails on a second use                               |
| `POST /v1/sessions/list`       | 200 with 326 real sessions                                                             |
| `POST /v1/sessions/running`    | 200                                                                                    |
| `POST /v1/sessions/:id/models` | 200                                                                                    |
| `POST /v1/settings/describe`   | 200                                                                                    |
| `GET /v1/events`               | 200 SSE stream: `gateway/ready` then heartbeats                                        |

The QR payload is additionally checked by decoding the drawn code with an
independent decoder (OpenCV) and comparing it to the string that was encoded.

Two routes are still limited:

- **History** — `session/page` requires `throughSeq`, which the gateway reads from
  the `session/follow` opening frame. That frame's cursor field does not map in
  the current release, so the page call is rejected.
- **Search** — the host answers `session search is disabled: this deployment
configures the session-query…`, so a profile without session-query refuses it.
  That is a deployment setting, not a bridge defect.

## Limits worth knowing

- A quick tunnel changes its address on every reconnect; use a named tunnel for a
  stable one.
- `cloudflared` needs its edge connection to reach `*.argotunnel.com` and
  `*.cloudflare.com` directly. A transparent proxy that captures those flows breaks
  the tunnel; route them direct.
- A free Apple ID's install expires after seven days; that is a signing limit, not
  a bridge limit.

### Goal, task and archive controls

Paired clients can read the live goal (including process-local activation) with `POST /v1/sessions/:id/goal/read` and create one with `POST /v1/sessions/:id/goal/create` using `{ "objective": "..." }`. Existing edit/pause/resume/clear routes retain the desktop compare-and-set reference. Goal creation and reads forward to `goals/create` and `goals/get`; no second goal store is introduced.

Run `npm run test:goals` to verify the HTTP boundary with a synthetic desktop wire. Rebuild and update the installed phone-access plugin before using these routes from a newer mobile client.

The task catalog is available through `POST /v1/schedules/catalog`. Versioned pause/resume/delete use `/v1/schedules/:id/:action` with `expectedUpdatedAt`; these forward only the corresponding `schedule/edit` operations. Archived sessions can be restored through `POST /v1/sessions/:id/unarchive`. All routes require paired-device authorization. The synthetic HTTP boundary check covers these routes as well as goals.
Slash-command discovery is available through `POST /v1/sessions/:id/commands`, which forwards `commands/list` and returns `{ items }` of the Host's `CommandDescriptor` records. The native `/` trigger menu needs it; without the route the phone can only send commands it already knows by name.

Account reads are deliberately read-only: `POST /v1/account/profile` and `POST /v1/account/balance` forward `account/getProfile` and `account/getBalance` with the `{ version, locale, timezoneOffsetSeconds }` client metadata the Host requires. Sign-in, sign-out and bonus acknowledgement never cross the gateway, because its device credential carries no scope: a paired phone may read the balance but cannot change the account. Unknown `/v1/account/*` paths stay 404.

## Background jobs, schedules and Workspaces

- `POST /v1/sessions/:id/queue` and `POST /v1/sessions/:id/jobs` return `{ items }`
  for one Session. The `session/control` baseline carries projections only, so
  these snapshots come from two per-Session streams opened alongside
  `session/follow`: `session/observeState` feeds the queue, `job/list` feeds the
  job roster, and each also broadcasts `session/queue` / `session/jobs` frames to
  subscribed devices. When no stream has cached a value yet, the route performs
  one direct read (`session/state`, or the opening `job/list` frame) so a polling
  REST client still sees live data.
- `POST /v1/sessions/:id/jobs/:jobId/kill` forwards `job/kill`, so a job shown in
  the activity panel can also be stopped from it.
- `POST /v1/schedules/create` forwards `schedule/create` with the Host's own
  `ScheduleCreateRequest` (`title`, `prompt`, `timing` and optional `target`).
  `POST /v1/schedules/:id/run`, `/view` and `/history` forward `schedule/run`,
  `schedule/view` and `schedule/history`. The gateway checks only the fields a
  client cannot omit; the Host validates the typed timing and target unions and
  returns its structured input errors.
- `POST /v1/sessions/:id/pin` and `/unpin` forward `workspace/pinSession` and
  `workspace/unpinSession`. Pinning is registry-global: the `workspace/follow`
  stream publishes the whole pinned set, which `/v1/sessions/list` now reports
  as `pinnedSessionIds` alongside `workspaces` and `archivedSessionIds`.
- `POST /v1/workspaces/create` forwards `workspace/create` with a `path`.

## Sub-agents

`POST /v1/sessions/:id/subagents` lists one parent's direct children. No
`subagents/list` Remote exists in the current Host, so the gateway reads the
`subagentCatalog` projection through `session/projections` and adds the two facts
the projection does not carry: `activity` from `session/list` `running`, and
`hasChildren` from a cached grandchild catalog. A child whose `mode` is neither
`one-shot` nor `continuable` is reported as
`{ kind: 'diagnostic', reason: 'unsupported' }` rather than dropped.

`POST /v1/sessions/:parentId/subagents/:childId/interrupt` forwards
`subagents/interruptByUser` with `{ childSessionId }`. The parent segment is
decoded for validation only; the Host authorizes the interrupt on the child's own
Session. `mode` must be `continuable`.

## Development

`npm run typecheck` checks every TypeScript source under `src/`; no type
information is shipped, but the check catches drift against the Host's wire
shapes. `npm run format:check` and `npm run test:goals` are the other two gates.
`npm run verify` runs typecheck, the esbuild bundle and a Node syntax check in
that order, and `prepack` invokes it so a stale bundle cannot be published.
