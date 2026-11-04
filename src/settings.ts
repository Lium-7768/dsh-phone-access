/**
 * Choices the operator makes in the settings section, kept across restarts.
 *
 * The packaged defaults live in `cordis.patch.yml`, which a reader of the settings
 * page cannot edit. Everything a phone connection depends on is therefore also a
 * choice here: whether the front listens beyond loopback, and which public tunnel
 * runs. A value present in this file wins over the packaged config.
 *
 * @module dsh-phone-access/settings
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** Public tunnel modes the section may choose. */
export type TunnelMode = 'named' | 'quick' | 'off'

/** What the section can change. */
export interface BridgeSettings {
  /** Accept phones on the local network. */
  lan: boolean
  /** Which public tunnel to run. */
  tunnel: TunnelMode
  /** Tunnel name created by `cloudflared tunnel create`, for `named`. */
  tunnelName: string
  /** Public hostname routed to the named tunnel. */
  hostname: string
}

/** Where the choices are stored. */
export const DEFAULT_SETTINGS_FILE = 'settings.json'

/**
 * Read the stored choices, falling back to the packaged defaults.
 *
 * A malformed file is ignored rather than fatal: the bridge must still start, and
 * the section shows the packaged defaults so the operator can save again.
 *
 * @param path - File holding the choices.
 * @param fallback - Values from `cordis.patch.yml`.
 * @returns The choices in effect.
 */
export function readSettings(path: string, fallback: BridgeSettings): BridgeSettings {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<Record<keyof BridgeSettings, unknown>>
    return {
      lan: typeof parsed.lan === 'boolean' ? parsed.lan : fallback.lan,
      tunnel:
        parsed.tunnel === 'named' || parsed.tunnel === 'quick' || parsed.tunnel === 'off'
          ? parsed.tunnel
          : fallback.tunnel,
      tunnelName:
        typeof parsed.tunnelName === 'string' && parsed.tunnelName !== '' ? parsed.tunnelName : fallback.tunnelName,
      hostname: typeof parsed.hostname === 'string' ? parsed.hostname : fallback.hostname,
    }
  } catch {
    return fallback
  }
}

/**
 * Persist the choices.
 *
 * @param path - File holding the choices.
 * @param value - Choices to store.
 */
export function writeSettings(path: string, value: BridgeSettings): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2), { mode: 0o600 })
}
