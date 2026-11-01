/**
 * RPC surface the Settings section calls.
 *
 * The section needs the address, the password, and the device list, and needs to
 * rotate the password and revoke a device. These travel over this plugin's own
 * channel rather than the shared `/api` one, so the section never depends on how
 * the host routes that shared prefix.
 */
import { BRIDGE_ENDPOINTS, BRIDGE_RPC_CHANNEL } from '../client/api.js'
import type { MobileDeviceRegistry } from './gateway/device-registry.ts'
import { passwordProblem, type PasswordStore } from './password.ts'
import type { BridgeSettings, TunnelMode } from './settings.ts'

/** What the section wants to know. */
export interface BridgeStatus {
  /** Public address, or null when no tunnel is running. */
  publicUrl: string | null
  /** Routable LAN origin, or null when the front still listens on loopback only. */
  lanUrl: string | null
  /** Hostname the named tunnel serves, when configured. */
  hostname: string | null
  /** Password the front accepts. */
  password: string
  /** Whether a tunnel process is running. */
  tunnelRunning: boolean
  /** Whether the tunnel reported a registered connection. */
  tunnelConnected: boolean
  /** Why the last tunnel attempt failed, or null when it succeeded. */
  tunnelError: string | null
  /** Choices in effect, for the section's form. */
  settings: BridgeSettings
  /** Front listener port on loopback. */
  frontPort: number
  /** Paired devices, newest last. */
  devices: readonly { deviceId: string; label: string; createdAt: string }[]
}

/** One RPC result, matching the connection handler's expectation. */
type Result = { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } }

/** Reads and mutates the live bridge state. */
export interface SettingsRpcOptions {
  /** Current status reader. */
  status: () => BridgeStatus
  /** Password store, so the section can rotate it. */
  password: PasswordStore
  /** Device registry, so the section can revoke one. */
  devices: MobileDeviceRegistry
  /** Issues the one-time secret a scanned QR carries. */
  createPairing: (label: string) => { pairingId: string; pairingSecret: string; expiresAt: string }
  /** Starts the tunnel again, replacing a dead one. */
  restartTunnel: () => Promise<void>
  /** Reports a rotation or revocation. */
  log: (message: string) => void
}

/**
 * Handle one endpoint call.
 *
 * @param options - Live state readers and mutators.
 * @param endpoint - Endpoint name from the client.
 * @param payload - Decoded call payload.
 * @returns The handler result.
 */
export async function handleSettingsRpc(
  options: SettingsRpcOptions,
  endpoint: string,
  payload: unknown,
): Promise<Result> {
  if (endpoint === BRIDGE_ENDPOINTS.status) {
    return { ok: true, value: options.status() }
  }
  if (endpoint === BRIDGE_ENDPOINTS.rotatePassword) {
    const next = options.password.rotate()
    options.log('rotated the access password from the settings section')
    return { ok: true, value: { password: next } }
  }
  if (endpoint === BRIDGE_ENDPOINTS.createPairing) {
    const body = payload as { label?: unknown } | undefined
    const raw = typeof body?.label === 'string' ? body.label.trim() : ''
    const label = raw === '' ? '手机' : raw
    const status = options.status()
    // A phone can only reach what it can route to: the tunnel when one runs,
    // otherwise the LAN origin.
    const gatewayUrl = status.publicUrl ?? status.lanUrl
    if (gatewayUrl === null) {
      return {
        ok: false,
        error: {
          code: 'no-address',
          message: '没有手机可用的地址：开启隧道，或在插件配置里把 lan 设为 true 让手机走局域网。',
        },
      }
    }
    const pairing = options.createPairing(label)
    options.log(`created a pairing code for ${label}`)
    return { ok: true, value: { version: 1, gatewayUrl, ...pairing } }
  }
  if (endpoint === BRIDGE_ENDPOINTS.updateSettings) {
    const body = payload as Record<string, unknown> | undefined
    const current = options.settings()
    const mode = body?.tunnel
    const next: BridgeSettings = {
      lan: typeof body?.lan === 'boolean' ? body.lan : current.lan,
      tunnel: mode === 'named' || mode === 'quick' || mode === 'off' ? mode : current.tunnel,
      tunnelName: typeof body?.tunnelName === 'string' && body.tunnelName.trim() !== '' ? body.tunnelName.trim() : current.tunnelName,
      hostname: typeof body?.hostname === 'string' ? body.hostname.trim() : current.hostname,
    }
    await options.applySettings(next)
    return { ok: true, value: options.status() }
  }
  if (endpoint === BRIDGE_ENDPOINTS.reconnectTunnel) {
    await options.restartTunnel()
    return { ok: true, value: options.status() }
  }
  if (endpoint === BRIDGE_ENDPOINTS.setPassword) {
    const body = payload as { password?: unknown } | undefined
    const candidate = typeof body?.password === 'string' ? body.password.trim() : ''
    const problem = passwordProblem(candidate)
    if (problem !== undefined) return { ok: false, error: { code: 'invalid-password', message: problem } }
    const stored = options.password.set(candidate)
    options.log('set a custom access password from the settings section')
    return { ok: true, value: { password: stored } }
  }
  if (endpoint === BRIDGE_ENDPOINTS.deleteDevice) {
    const body = payload as { deviceId?: unknown } | undefined
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined
    if (deviceId === undefined) return { ok: false, error: { code: 'bad-request', message: '缺少设备标识。' } }
    // Revoke first so the phone's bearer token stops working before the record
    // leaves the list; a delete that only forgot the row would leave it connected.
    options.devices.revoke(deviceId)
    const removed = options.devices.remove(deviceId)
    if (removed) options.log(`removed device ${deviceId} from the settings section`)
    return { ok: true, value: { removed } }
  }
  if (endpoint === BRIDGE_ENDPOINTS.revokeDevice) {
    const body = payload as { deviceId?: unknown } | undefined
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId : undefined
    if (deviceId === undefined) return { ok: false, error: { code: 'bad-request', message: '缺少设备标识。' } }
    const removed = options.devices.revoke(deviceId)
    if (removed) options.log(`revoked device ${deviceId} from the settings section`)
    return { ok: true, value: { removed } }
  }
  return { ok: false, error: { code: 'not-found', message: `未知的端点：${endpoint}` } }
}

export { BRIDGE_RPC_CHANNEL }
