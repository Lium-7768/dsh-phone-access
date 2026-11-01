/**
 * Mobile bridge: lets the native DeepSeek Harness client reach this desktop over
 * the public internet with an address and a password.
 *
 * Three parts, each owned here rather than in the upstream gateway:
 *
 * - the gateway itself, which projects sessions over the loopback wire protocol;
 * - a front listener that answers the password sign-in and forwards the rest;
 * - a Cloudflare quick tunnel that gives the front a public address.
 *
 * The gateway keeps listening on loopback, and the device registry is persisted so
 * a desktop restart does not invalidate every paired phone.
 *
 * @module dsh-phone-access
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { MobileGateway } from './gateway/mobile-gateway.ts'

import { startFront, type FrontHandle } from './front.ts'
import { exchangeLaunchToken } from './launch-token.ts'
import { PasswordStore } from './password.ts'
import { PersistentDeviceRegistry } from './persistent-registry.ts'
import { BRIDGE_RPC_CHANNEL, handleSettingsRpc } from './settings-rpc.ts'
import { readSettings, writeSettings, type BridgeSettings, type TunnelMode } from './settings.ts'
import { startNamedTunnel, startTunnel, type TunnelHandle } from './tunnel.ts'

/** Largest request body the settings route accepts; the section posts small JSON. */
const MAX_BRIDGE_BODY_BYTES = 1024 * 1024

/** Cordis plugin name used by loader diagnostics. */
export const name = 'dsh-phone-access'

/** Configuration accepted from `cordis.patch.yml`. */
export interface Config {
  /** Whether the bridge runs at all. */
  enabled?: boolean
  /** Port the front listener binds on loopback; `0` picks a free one. */
  port?: number
  /**
   * Tunnel mode.
   *
   * `quick` prints a fresh `trycloudflare.com` address on every start, so a saved
   * address stops working after a restart. `named` uses a tunnel created once in
   * the account, whose hostname never changes.
   */
  tunnel?: boolean | 'quick' | 'named'
  /** Tunnel name created by `cloudflared tunnel create`, for `named` mode. */
  tunnelName?: string
  /** Public hostname routed to the named tunnel, for `named` mode. */
  hostname?: string
  /**
   * File holding a public address published by something outside this plugin.
   *
   * The Cloudflare tunnel needs an outbound edge connection this host cannot make,
   * so a reverse SSH tunnel keeps the public address instead. It reconnects with a
   * new hostname, so the address is read on every status call and the pairing QR
   * always carries the one that is live now.
   */
  publicUrlFile?: string
  /** Where the password and device list live. */
  dataDir?: string
  /**
   * Accept phones on the local network.
   *
   * The front listener binds loopback for the tunnel; a phone on the same Wi-Fi
   * needs a routable address instead, so this binds it to every interface and
   * the QR payload carries `http://<lan-address>:<port>`.
   */
  lan?: boolean
}

/** Live bridge state the Settings section reads, set once boot completes. */
let settingsSectionState: SettingsSectionState | undefined

/** Live bridge state the Settings section reads, set once boot completes. */
interface SettingsSectionState {
  publicUrl: () => string | null
  /** Routable LAN origin, present only when the front listens beyond loopback. */
  lanUrl: () => string | null
  hostname: () => string | null
  password: PasswordStore
  devices: PersistentDeviceRegistry
  tunnelRunning: () => boolean
  tunnelConnected: () => boolean
  /** Why the last tunnel attempt failed, or null when it succeeded. */
  tunnelError: () => string | null
  frontPort: number
  /** Issues the one-time secret a scanned QR carries. */
  createPairing: (label: string) => { pairingId: string; pairingSecret: string; expiresAt: string }
  /** Starts the tunnel again, replacing a dead one. */
  restartTunnel: () => Promise<void>
  /** Choices currently in effect. */
  settings: () => BridgeSettings
  /** Stores and applies new choices. */
  applySettings: (next: BridgeSettings) => Promise<void>
}

/** Resolved settings. */
interface ResolvedConfig {
  enabled: boolean
  port: number
  tunnel: boolean | 'quick' | 'named'
  tunnelName: string
  hostname: string
  dataDir: string
  lan: boolean
  publicUrlFile: string
  /** Packaged tunnel mode, used until the section saves a choice. */
  tunnelMode: TunnelMode
}

/**
 * Apply the configuration defaults.
 *
 * @param raw - Configuration from `cordis.patch.yml`.
 * @returns Settings with every field present.
 */
function resolveConfig(raw: Config): ResolvedConfig {
  return {
    enabled: raw.enabled ?? true,
    port: raw.port ?? 0,
    tunnel: raw.tunnel ?? true,
    tunnelName: raw.tunnelName ?? '',
    hostname: raw.hostname ?? '',
    lan: raw.lan ?? false,
    publicUrlFile: raw.publicUrlFile ?? '',
    tunnelMode: raw.tunnel === false || raw.tunnel === undefined ? (raw.tunnel === false ? 'off' : 'quick') : raw.tunnel,
    // An empty string in cordis.patch.yml means "use the default", not "write to
    // the current directory": mkdirSync('') throws.
    dataDir: raw.dataDir !== undefined && raw.dataDir.trim() !== ''
      ? raw.dataDir
      : join(homedir(), '.dsh', 'mobile-bridge'),
  }
}

/**
 * Register the bridge.
 *
 * @param ctx - The plugin context.
 * @param raw - Configuration from `cordis.patch.yml`.
 */
export function apply(ctx: Context, raw: Config = {}): void {
  const cfg = resolveConfig(raw)
  if (!cfg.enabled) return
  const log = (message: string): void => {
    ctx.logger?.info?.(`mobile-bridge: ${message}`)
  }
  const warn = (message: string): void => {
    ctx.logger?.warn?.(`mobile-bridge: ${message}`)
  }

  // `/api` admits only an authenticated peer in the current release, so the
  // gateway's loopback client carries the cookie the host mints from its launch
  // token. `authenticatedUrl` is the supported way to obtain that token.
  ctx.inject(['connection', 'webServer'], (hostCtx) => {
    const origin = hostCtx.webServer.getOrigin()

    // Boot first: the RPC surface below only serves what boot publishes, and an
    // error there must not stop the bridge from starting.
    void boot(origin, hostCtx.connection).catch((error: unknown) => {
      warn(error instanceof Error ? error.message : String(error))
    })

    // A channel of this plugin's own. The shared `/api` channel takes exactly one
    // interceptor and the gateway already owns it, while `connection.rpc.handle`
    // routes through the connection service's context and so cannot reach
    // `webServer`. Registering the route directly applies the same admission the
    // `/api` route does.
    hostCtx.effect(() => hostCtx.webServer.register({
      kind: 'prefix',
      path: BRIDGE_RPC_CHANNEL,
      handler: async (req, res) => {
        const rejection = hostCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection, { 'content-type': 'text/plain' })
          res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        const request = await readBridgeRequest(req)
        if (request === undefined) {
          writeBridgeResponse(res, 'invalid-request', {
            ok: false,
            error: { code: 'invalid-request', message: '请求格式无效。', details: {} },
          })
          return
        }
        writeBridgeResponse(res, request.rpcId, await bridgeRpc(request.method, request.payload))
      },
    }), 'mobile-bridge: settings route')

    /**
     * Answer one `bridge.*` endpoint on the shared channel.
     *
     * @param endpoint - the endpoint the section asked for.
     * @param payload - the endpoint's arguments.
     * @returns the section's result envelope.
     */
    async function bridgeRpc(endpoint: string, payload: unknown): Promise<unknown> {
      const state = settingsSectionState
      if (state === undefined) {
        return { ok: false, error: { code: 'starting', message: '手机访问尚未启动完成。' } }
      }
      return handleSettingsRpc({
        status: () => ({
          publicUrl: state.publicUrl(),
          lanUrl: state.lanUrl(),
          hostname: state.hostname(),
          password: state.password.value,
          tunnelRunning: state.tunnelRunning(),
          tunnelConnected: state.tunnelConnected(),
          frontPort: state.frontPort,
          tunnelError: state.tunnelError(),
          settings: state.settings(),
          devices: state.devices
            .list()
            .filter(device => device.revokedAt === undefined)
            .map(device => ({
              deviceId: device.deviceId,
              label: device.label,
              createdAt: device.createdAt,
            })),
        }),
        password: state.password,
        devices: state.devices,
        createPairing: label => state.createPairing(label),
        restartTunnel: state.restartTunnel,
        settings: state.settings,
        applySettings: state.applySettings,
        log: message => log(message),
      }, endpoint, payload)
    }

    /**
     * Start the gateway, the front, and the tunnel, then publish the result.
     *
     * @param hostOrigin - Loopback origin of the running host.
     * @param connection - Host connection service, which mints the launch token.
     */
    async function boot(hostOrigin: string, connection: { authenticatedUrl(baseUrl: string): string }): Promise<void> {
      mkdirSync(cfg.dataDir, { recursive: true })
      const password = new PasswordStore(join(cfg.dataDir, 'password'))
      const devices = new PersistentDeviceRegistry(join(cfg.dataDir, 'devices.json'))
      const cookie = await exchangeLaunchToken(connection.authenticatedUrl(hostOrigin))
      if (cookie === undefined) warn('could not obtain a loopback cookie; /api calls will be rejected')
      // Each stream gets its own peer: a peer owns one socket, and the host drops
      // it when that socket ends, so a shared credential would 401 the rest.
      const mintCookie = async (): Promise<string | undefined> => {
        try {
          return await exchangeLaunchToken(connection.authenticatedUrl(hostOrigin))
        } catch {
          return undefined
        }
      }
      const gateway = new MobileGateway({ dshUrl: hostOrigin, devices, cookie, cookieProvider: mintCookie })
      const { url: gatewayUrl } = await gateway.start()
      log(`gateway listening at ${gatewayUrl}`)

      // A choice saved from the section wins over the packaged config, so a reader
      // who cannot edit cordis.patch.yml can still decide what the phone reaches.
      const settingsPath = join(cfg.dataDir, 'settings.json')
      let settings: BridgeSettings = readSettings(settingsPath, {
        lan: cfg.lan,
        tunnel: cfg.tunnelMode,
        tunnelName: cfg.tunnelName,
        hostname: cfg.hostname,
      })

      const listenHost = (): string => (settings.lan ? '0.0.0.0' : '127.0.0.1')
      let front: FrontHandle = await startFront({
        gatewayUrl,
        devices,
        password,
        port: cfg.port,
        host: listenHost(),
        log: message => log(message),
      })
      let lanAddress = settings.lan ? pickLanAddress() : null
      log(`front listening on ${listenHost()}:${String(front.port)}`)

      /**
       * Rebind the front listener without changing its port.
       *
       * A listener cannot widen its own bind, so a LAN toggle closes the socket and
       * opens a new one on the same port. The tunnel is reattached to the new port
       * because its forward is fixed to the old one.
       */
      const rebindFront = async (): Promise<void> => {
        const previous = front.port
        await front.close()
        front = await startFront({
          gatewayUrl,
          devices,
          password,
          port: previous,
          host: listenHost(),
          log: message => log(message),
        })
        lanAddress = settings.lan ? pickLanAddress() : null
        log(`front rebound to ${listenHost()}:${String(front.port)}`)
      }

      // Publish the section state before the tunnel: the LAN address and the
      // pairing endpoint do not depend on it, and a reader who opens Settings must
      // not meet "still starting" while cloudflared waits on a dead edge.
      let tunnel: TunnelHandle | undefined
      let tunnelError: string | null = null
      let tunnelStarting = false

      /**
       * Address published by the reverse tunnel that lives outside this plugin.
       *
       * Read on every call rather than cached: the tunnel reconnects with a new
       * hostname, and a cached value would hand the phone an address that is gone.
       *
       * @returns The current address, or null when the file is absent or empty.
       */
      const externalPublicUrl = (): string | null => {
        if (cfg.publicUrlFile === '') return null
        try {
          const value = readFileSync(cfg.publicUrlFile, 'utf8').trim()
          return /^https?:\/\//.test(value) ? value : null
        } catch {
          return null
        }
      }

      const publishStatus = (): void => {
        const status = {
          publicUrl: tunnel?.publicUrl ?? externalPublicUrl(),
          lanUrl: lanAddress === null ? null : `http://${lanAddress}:${String(front.port)}`,
          password: password.value,
          frontPort: front.port,
          tunnelError,
          updatedAt: new Date().toISOString(),
        }
        writeFileSync(join(cfg.dataDir, 'status.json'), JSON.stringify(status, null, 2), { mode: 0o600 })
      }

      /**
       * Start the tunnel, or replace a dead one.
       *
       * Called at boot, from the settings section's retry control, and by the
       * background schedule. Re-entrant calls are ignored, so a reader pressing
       * retry twice cannot spawn two cloudflared processes.
       */
      const connectTunnel = async (): Promise<void> => {
        if (settings.tunnel === 'off' || tunnelStarting) return
        tunnelStarting = true
        try {
          // The edge registration retries several connections; a healthy start took
          // about 40 seconds here. The attempt runs in the background, so a slow
          // success costs nothing but a late address.
          const timeoutMs = 90_000
          const next = settings.tunnel === 'named'
            ? await startNamedTunnel({ name: settings.tunnelName, hostname: settings.hostname, port: front.port, log, timeoutMs })
            : await startTunnel({ port: front.port, log, timeoutMs })
          tunnel?.stop()
          tunnel = next
          tunnelError = null
          log(`public address ${next.publicUrl}`)
        } catch (error) {
          tunnelError = error instanceof Error ? error.message : String(error)
          warn(`tunnel unavailable: ${tunnelError}`)
        } finally {
          tunnelStarting = false
          publishStatus()
        }
      }

      /**
       * Apply choices saved from the section.
       *
       * Rebinds the front when LAN access changes, then restarts the tunnel when
       * its mode changed. Both steps log their own outcome; a failure leaves the
       * previous listener or tunnel in place so the page keeps working.
       *
       * @param next - Choices to store and apply.
       */
      const applySettings = async (next: BridgeSettings): Promise<void> => {
        const lanChanged = next.lan !== settings.lan
        const tunnelChanged = next.tunnel !== settings.tunnel
          || next.tunnelName !== settings.tunnelName
          || next.hostname !== settings.hostname
        settings = next
        writeSettings(settingsPath, settings)
        if (lanChanged) {
          await rebindFront()
          // The tunnel forwards to a fixed port, so a rebind keeps it valid.
        }
        if (tunnelChanged) {
          tunnel?.stop()
          tunnel = undefined
          tunnelError = null
          if (settings.tunnel === 'off') {
            log('public tunnel disabled from the settings section')
          } else {
            await connectTunnel()
          }
        }
        publishStatus()
      }

      settingsSectionState = {
        publicUrl: () => tunnel?.publicUrl ?? externalPublicUrl(),
        lanUrl: () => lanAddress === null ? null : `http://${lanAddress}:${String(front.port)}`,
        hostname: () => settings.hostname === '' ? null : settings.hostname,
        password,
        devices,
        tunnelRunning: () => tunnel !== undefined,
        tunnelConnected: () => tunnel !== undefined,
        tunnelError: () => tunnelError,
        settings: () => settings,
        frontPort: front.port,
        createPairing: label => gateway.createPairing(label),
        restartTunnel: connectTunnel,
        applySettings,
      }

      publishStatus()
      void connectTunnel()
      // A blocked edge usually clears on its own. Keep trying in the background so
      // a transient failure does not require restarting the whole application.
      const tunnelRetry = setInterval(() => {
        if (tunnel === undefined && !tunnelStarting) void connectTunnel()
      }, 120_000)
      tunnelRetry.unref?.()

      ctx.effect(() => () => {
        clearInterval(tunnelRetry)
        tunnel?.stop()
        void front.close()
        void gateway.stop()
      })
    }
  })
}


/**
 * First routable IPv4 address, for the phone's LAN origin.
 *
 * VPN and AirDrop interfaces are skipped: they carry addresses the phone cannot
 * reach even though they are not marked internal.
 *
 * @returns The address, or null when the machine is on no usable network.
 */
function pickLanAddress(): string | null {
  for (const [name, infos] of Object.entries(networkInterfaces())) {
    if (/^(utun|bridge|awdl|llw|anpi|gif)/.test(name)) continue
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) return info.address
    }
  }
  return null
}

/** One decoded request on the plugin's own channel. */
interface BridgeRequest {
  readonly rpcId: string
  readonly method: string
  readonly payload: unknown
}

/**
 * Read one request body on the plugin's channel.
 *
 * @param req - the incoming request.
 * @returns the decoded request, or undefined when the body is not a client request.
 */
async function readBridgeRequest(req: IncomingMessage): Promise<BridgeRequest | undefined> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk as Buffer)
    total += buffer.byteLength
    if (total > MAX_BRIDGE_BODY_BYTES) return undefined
    chunks.push(buffer)
  }
  if (chunks.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    // A body the section did not write; the route answers with a protocol error.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const body = parsed as { type?: unknown; rpcId?: unknown; method?: unknown; payload?: unknown }
  if (body.type !== 'client-request' || typeof body.rpcId !== 'string' || typeof body.method !== 'string') return undefined
  return { rpcId: body.rpcId, method: body.method, payload: body.payload }
}

/**
 * Write one response on the plugin's channel.
 *
 * @param res - the response to complete.
 * @param rpcId - correlation id echoed from the request.
 * @param result - the success or failure envelope the client parses.
 */
function writeBridgeResponse(
  res: ServerResponse,
  rpcId: string,
  result:
    | { ok: true; value: unknown }
    | { ok: false; error: { code: string; message: string; details?: unknown } },
): void {
  const framed = result.ok
    ? result
    : { ...result, error: { ...result.error, details: result.error.details ?? {} } }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ type: 'server-response', rpcId, result: framed }))
}
