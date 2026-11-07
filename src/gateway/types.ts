/** A paired mobile device allowed to call the loopback Mobile Gateway. */
export interface MobileDevice {
  deviceId: string
  label: string
  createdAt: string
  revokedAt?: string
}

/** One short-lived, out-of-band device credential returned after desktop approval. */
export interface MobileDeviceCredential {
  deviceId: string
  accessToken: string
}

/** A stable response emitted by the Mobile Gateway. */
export interface MobileResponse<T> {
  contractVersion: 1
  dshUrl: string
  data: T
}

/** Error codes emitted by the mobile transport or a translated DSH RPC. */
export type MobileGatewayErrorCode =
  | 'bad-request'
  | 'unauthorized'
  | 'forbidden'
  | 'not-found'
  | 'session-not-found'
  | 'model-unavailable'
  | 'agent-preset-locked'
  | 'agent-preset-not-found'
  | 'agent-preset-invalid'
  | 'settings-rejected'
  | 'settings-conflict'
  | 'pairing-not-found'
  | 'upstream-unavailable'
  | 'upstream-rejected'

/** A Mobile Gateway HTTP fault that is safe to show in a native client. */
export interface MobileGatewayError {
  code: MobileGatewayErrorCode
  message: string
}

/** One redacted secret slot in a settings namespace. */
export interface MobileSettingsSecretView {
  path: string[]
  set: boolean
}

/** Redacted settings namespace returned to a paired mobile client. */
export interface MobileSettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: MobileSettingsSecretView[]
  revision: number
}

/** Settings catalog exposed by the desktop runtime. */
export interface MobileSettingsPayload {
  writable: boolean
  hasDocument: boolean
  namespaces: MobileSettingsNamespaceView[]
}

/** One provider's model catalog as advertised by the desktop runtime. */
export interface MobileModelProviderGroup {
  id: string
  name: string
  models: MobileModelCatalogModel[]
}

/** One model in a provider group. */
export interface MobileModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: Array<{ id: string; name: string; description?: string }>
    defaultEffort?: string
  }
}

/** A provider catalog lookup failure that does not invalidate successful groups. */
export interface MobileModelCatalogFailure {
  id: string
  name: string
  message: string
}

/** Session model selection and the provider catalog used by the composer. */
export interface MobileSessionModelsPayload {
  current: { provider: string; model: string; reasoningEffort?: string }
  routable: boolean
  groups: MobileModelProviderGroup[]
  failures: MobileModelCatalogFailure[]
}

/** Agent preset entry offered by the desktop runtime. */
export interface MobileAgentPresetEntry {
  id: string
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}

/** One workspace path the `@` menu can complete, as the file-reference provider reports it. */
export interface MobileReferenceFileCandidate {
  /** User-facing path accepted by prompts and filesystem tools. */
  path: string
  /** Directories keep completion open; files finish the mention. */
  kind: 'file' | 'directory'
}

/** One Session the `@` menu can reference, as the session-reference resolver reports it. */
export interface MobileReferenceSessionCandidate {
  sessionId: string
  /** Latest log-backed title, falling back to the opaque session id. */
  label: string
  /** Display and canonical-mention text, preferring a subagent's creation label. */
  displayTitle?: string
  /** Canonical `@[label](dsh-session:…)` mention serialized into the draft. */
  mention: string
  /** Whether the source Session shares the requesting Session's workspace. */
  sameWorkspace: boolean
  createdAt: number
}

/** Both `@` menus' candidate lists for one query. */
export interface MobileReferencePayload {
  files: MobileReferenceFileCandidate[]
  sessions: MobileReferenceSessionCandidate[]
}
