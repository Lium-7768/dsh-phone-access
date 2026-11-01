/**
 * Device registry that survives a desktop restart.
 *
 * The upstream registry keeps paired devices in memory, so every restart forgets
 * them and the phone has to pair again. This subclass hydrates from a JSON file
 * and writes it back after each mutation.
 */
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { MobileDeviceRegistry, type MobileDeviceSnapshot } from './gateway/device-registry.ts'

/** Registry bound to one file on disk. */
export class PersistentDeviceRegistry extends MobileDeviceRegistry {
  readonly #path: string

  /**
   * @param path - File holding the device snapshots.
   */
  constructor(path: string) {
    super(load(path))
    this.#path = path
  }

  /**
   * Create one device credential and persist it.
   *
   * @param label - Human-readable device label.
   * @returns The new credential.
   */
  override create(label: string) {
    const credential = super.create(label)
    this.#flush()
    return credential
  }

  /**
   * Revoke one device and persist the result.
   *
   * @param deviceId - Device to revoke.
   * @returns Whether a device was removed.
   */
  override revoke(deviceId: string): boolean {
    const removed = super.revoke(deviceId)
    if (removed) this.#flush()
    return removed
  }

  /**
   * Drop one device record and persist the result.
   *
   * @param deviceId - Device to remove.
   * @returns Whether a record was removed.
   */
  override remove(deviceId: string): boolean {
    const removed = super.remove(deviceId)
    if (removed) this.#flush()
    return removed
  }

  /** Write the current snapshot, readable only by the owner. */
  #flush(): void {
    mkdirSync(dirname(this.#path), { recursive: true })
    writeFileSync(this.#path, JSON.stringify(this.snapshot(), null, 2), { mode: 0o600 })
    chmodSync(this.#path, 0o600)
  }
}

/**
 * Read the stored snapshots, treating a missing or unreadable file as empty.
 *
 * @param path - File holding the device snapshots.
 * @returns The snapshots to hydrate from.
 */
function load(path: string): MobileDeviceSnapshot[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return Array.isArray(parsed) ? (parsed as MobileDeviceSnapshot[]) : []
  } catch {
    return []
  }
}
