/**
 * Types for the browser-half constants both halves read.
 *
 * `client/api.js` stays plain JavaScript because the browser bundle loads it
 * directly; this file gives the Node half the same names.
 */

/** RPC channel the settings section calls. */
export declare const BRIDGE_RPC_CHANNEL: string

/** Endpoints the settings section may call. */
export declare const BRIDGE_ENDPOINTS: {
  readonly status: string
  readonly rotatePassword: string
  readonly revokeDevice: string
  readonly createPairing: string
  readonly setPassword: string
  readonly deleteDevice: string
  readonly reconnectTunnel: string
  readonly updateSettings: string
}
