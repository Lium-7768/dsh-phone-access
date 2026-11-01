/**
 * Shared constants between the browser half and the host half.
 *
 * The section and the host must agree on these strings, and the browser bundle
 * cannot import the Node entry, so they live in one JavaScript module both read.
 */

/**
 * RPC channel the settings section calls.
 *
 * A channel of this plugin's own: the shared `/api` channel accepts exactly one
 * interceptor and the gateway already owns it, so registering there would
 * displace the gateway's routing.
 */
export const BRIDGE_RPC_CHANNEL = '/dsh-mobile-bridge'

/** Endpoints the settings section may call. */
export const BRIDGE_ENDPOINTS = Object.freeze({
  status: 'bridge.status',
  rotatePassword: 'bridge.rotatePassword',
  revokeDevice: 'bridge.revokeDevice',
  createPairing: 'bridge.createPairing',
  setPassword: 'bridge.setPassword',
  deleteDevice: 'bridge.deleteDevice',
  reconnectTunnel: 'bridge.reconnectTunnel',
  updateSettings: 'bridge.updateSettings',
})
