import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { MobileDevice, MobileDeviceCredential } from './types.ts'

/** Serialized device data that never includes an access token. */
export interface MobileDeviceSnapshot extends MobileDevice {
  tokenHash: string
}

interface StoredDevice extends MobileDevice {
  tokenHash: Uint8Array
}

/** Keeps the active mobile-device allowlist in the desktop process. */
export class MobileDeviceRegistry {
  readonly #devices = new Map<string, StoredDevice>()

  /** @param snapshots - Persisted public metadata and token hashes to restore. */
  constructor(snapshots: readonly MobileDeviceSnapshot[] = []) {
    for (const snapshot of snapshots) {
      const hash = Buffer.from(snapshot.tokenHash, 'base64')
      if (hash.byteLength === 32 && snapshot.deviceId !== '' && snapshot.label !== '') {
        this.#devices.set(snapshot.deviceId, {
          deviceId: snapshot.deviceId,
          label: snapshot.label,
          createdAt: snapshot.createdAt,
          ...(snapshot.revokedAt === undefined ? {} : { revokedAt: snapshot.revokedAt }),
          tokenHash: hash,
        })
      }
    }
  }

  /**
   * Creates a device credential after a desktop user has confirmed pairing.
   * @param label - Human-readable label shown for the paired device.
   * @returns Durable device identifier and one bearer token returned only at creation.
   * @throws {Error} When the label is empty or exceeds the allowed length.
   */
  create(label: string): MobileDeviceCredential {
    const normalizedLabel = label.trim()
    if (normalizedLabel.length === 0 || normalizedLabel.length > 120) {
      throw new Error('A paired device label must contain between 1 and 120 characters.')
    }
    const deviceId = randomBytes(18).toString('base64url')
    const accessToken = randomBytes(32).toString('base64url')
    this.#devices.set(deviceId, {
      deviceId,
      label: normalizedLabel,
      createdAt: new Date().toISOString(),
      tokenHash: tokenHash(accessToken),
    })
    return { deviceId, accessToken }
  }

  /**
   * Lists paired devices without returning authentication material.
   * @returns Immutable device metadata without bearer tokens or token hashes.
   */
  list(): readonly MobileDevice[] {
    return [...this.#devices.values()].map(publicDevice)
  }

  /**
   * Returns a durable snapshot containing token hashes but no access tokens.
   * @returns Persistable device records for restoring the local allowlist.
   */
  snapshot(): readonly MobileDeviceSnapshot[] {
    return [...this.#devices.values()].map(device => ({
      ...publicDevice(device),
      tokenHash: Buffer.from(device.tokenHash).toString('base64'),
    }))
  }

  /**
   * Revokes a paired device immediately.
   * @param deviceId - Durable identifier of the paired device to revoke.
   * @returns `true` when an active device was marked revoked.
   */
  revoke(deviceId: string): boolean {
    const device = this.#devices.get(deviceId)
    if (device === undefined || device.revokedAt !== undefined) return false
    device.revokedAt = new Date().toISOString()
    return true
  }

  /**
   * Drops a device record entirely, so the desktop list stops showing it.
   *
   * A revoked device keeps its record so the console can explain what happened;
   * a removed one leaves no trace. Callers that must invalidate the token first
   * revoke, then remove.
   *
   * @param deviceId - Durable identifier of the device to drop.
   * @returns `true` when a record was removed.
   */
  remove(deviceId: string): boolean {
    return this.#devices.delete(deviceId)
  }

  /**
   * Verifies a device-bound bearer token without retaining its plaintext.
   * @param authorization - HTTP Authorization header carrying the device bearer token.
   * @returns Public device metadata when the token is current, otherwise `undefined`.
   */
  authenticate(authorization: string | undefined): MobileDevice | undefined {
    const match = authorization?.match(/^Bearer ([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/)
    if (match === null || match === undefined) return undefined
    const [, deviceId, accessToken] = match
    if (deviceId === undefined || accessToken === undefined) return undefined
    const device = this.#devices.get(deviceId)
    if (device === undefined || device.revokedAt !== undefined) return undefined
    const candidate = tokenHash(accessToken)
    if (candidate.byteLength !== device.tokenHash.byteLength || !timingSafeEqual(candidate, device.tokenHash))
      return undefined
    return publicDevice(device)
  }
}
function tokenHash(value: string): Uint8Array {
  return createHash('sha256').update(value).digest()
}

function publicDevice(device: StoredDevice): MobileDevice {
  return {
    deviceId: device.deviceId,
    label: device.label,
    createdAt: device.createdAt,
    ...(device.revokedAt === undefined ? {} : { revokedAt: device.revokedAt }),
  }
}
