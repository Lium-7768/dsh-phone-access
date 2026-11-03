import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { DshLoopbackClient, DshLoopbackError } from './dsh-loopback-client.ts'
import { MobileDeviceRegistry } from './device-registry.ts'
import type { MobileDevice, MobileDeviceCredential, MobileGatewayError, MobileResponse } from './types.ts'

/** Configuration for one loopback-only Mobile Gateway instance. */
export interface MobileGatewayOptions {
  /**
   * Base URL of the local desktop DSH runtime.
   *
   * Omitted when {@link MobileGatewayOptions.wireClient} is supplied, because the
   * client then reaches the runtime without a listener.
   */
  dshUrl?: string
  /**
   * Wire client that reaches the runtime.
   *
   * Supplied by an embedder that already holds an authenticated in-process peer;
   * omitting it keeps the loopback HTTP client.
   */
  wireClient?: MobileWireClient
  /**
   * Cookie the loopback client authenticates with.
   *
   * The current release admits `/api` only for an authenticated peer, so the
   * embedder exchanges the host launch token for this cookie and hands it over.
   */
  cookie?: string
  /**
   * Mints a cookie per stream.
   *
   * A host peer owns one socket, so streams cannot share a credential.
   */
  cookieProvider?: () => Promise<string | undefined>
  /** Durable paired-device registry; a new registry is created when omitted. */
  devices?: MobileDeviceRegistry
  /** Listener host; only loopback addresses are accepted. */
  host?: string
  /** Listener port; `0` selects an available local port. */
  port?: number
}

/** Bound listener address available after the Gateway starts. */
export interface MobileGatewayStatus {
  /** Authenticated mobile API base URL on the local listener. */
  url: string
}

/** The surface the gateway needs from a wire client. */
export interface MobileWireClient {
  /**
   * Invoke one unary endpoint.
   *
   * @param endpoint - `namespace/method` forwarded from the mobile route.
   * @param args - Named wire arguments.
   * @returns The business result.
   */
  call(endpoint: string, args: Record<string, unknown>): Promise<unknown>
  /**
   * Open one streaming endpoint.
   *
   * @param endpoint - `namespace/method`.
   * @param args - Named wire arguments.
   * @param signal - Aborts the stream.
   * @returns The stream's items.
   */
  open(endpoint: string, args: Record<string, unknown>, signal: AbortSignal): AsyncIterable<unknown>
}

/**
 * Read the runtime URL an HTTP wire client needs.
 *
 * @param options - Gateway options.
 * @returns The runtime base URL.
 * @throws {Error} When neither a URL nor a wire client was supplied.
 */
function requireDshUrl(options: MobileGatewayOptions): string {
  if (options.dshUrl === undefined) {
    throw new Error('The Mobile Gateway needs either dshUrl or wireClient.')
  }
  return options.dshUrl
}

const LOOPBACK_HOST = '127.0.0.1'
// Supports up to four compressed image blocks while still bounding one paired-device request.
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_PROMPT_IMAGES = 4
const MAX_PROMPT_TEXT_CHARS = 100_000
const MAX_IMAGE_BASE64_CHARS = 3 * 1024 * 1024
const MAX_SESSION_SEARCH_CHARS = 500
const IMAGE_MEDIA_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])
const PAIRING_TTL_MS = 5 * 60 * 1_000
const MAX_SUBSCRIPTION_BUFFER_EVENTS = 256

type PendingPairing = {
  label: string
  secretHash: Uint8Array
  expiresAt: number
}

type PendingInteraction = {
  rpcId: string
  type: 'approval/requested' | 'question/requested'
  sessionId: string
  payload: Record<string, unknown>
  receivedAt: string
}

/** Wire views of the DSH Remote surface; JSON-safe values pass through unmodified. */
type DshSessionSummary = {
  sessionId: string
  updatedAt?: number
  running?: boolean
  blank?: boolean
  title?: string
  projections?: { asOfSeq?: number; values?: Record<string, unknown> }
  [key: string]: unknown
}
type DshSessionList = { items?: DshSessionSummary[] }
type DshWorkspace = { workspaceId: string; title?: string; path?: string; sessionIds?: string[] }
type DshWorkspaceList = { items?: DshWorkspace[]; archivedSessionIds?: string[] }
type DshHistoryRecord = { type?: 'event'; event?: Record<string, unknown> }
type DshPage = { records?: DshHistoryRecord[]; hasMore?: boolean }
type DshFollowSnapshot = {
  type?: 'snapshot'
  cursor?: number
  records?: DshHistoryRecord[]
  hasMore?: boolean
  projections?: { asOfSeq?: number; values?: Record<string, unknown> }
}
type DshModelSelection = { provider: string; model: string; reasoningEffort?: string }
type DshModelCatalog = {
  default?: DshModelSelection
  routableProviders?: string[]
  groups?: unknown
  failures?: unknown
}
type DshControlFrame =
  | { type: 'baseline'; value?: { queues?: Record<string, unknown[]>; jobs?: Record<string, unknown[]> } }
  | { type: 'queue'; sessionId?: string; items?: unknown[] }
  | { type: 'jobs'; sessionId?: string; jobs?: unknown[] }
  | { type: 'projection'; sessionId?: string; key?: string; value?: unknown }
type DshWorkspaceFrame =
  | { type: 'baseline'; items?: DshWorkspace[]; archivedSessionIds?: string[] }
  | { type: 'upsert'; workspace?: DshWorkspace }
  | { type: 'remove'; workspaceId?: string }
  | { type: 'order'; workspaceIds?: string[] }
  | { type: 'archived'; archivedSessionIds?: string[] }
type DshEventFrame =
  | { type: 'ready'; clientId?: string }
  | { type: 'emit'; event?: string; args?: unknown[] }
  | { type: 'waterfall'; event?: string; eventId?: string; agentId?: string; request?: Record<string, unknown> }
  | { type: 'cancel'; eventId?: string }

type MobileHistoryItem = { seq?: number; event: Record<string, unknown> }
type MobileStreamEvent = {
  contractVersion: 1
  eventId: string
  type: string
  payload: Record<string, unknown>
  rpcId?: string
  sessionId?: string
  seq?: number
  snapshot?: true
}

type SessionSubscription = {
  subscriptionId: string
  activationToken: string
  deviceId: string
  sessionId: string
  cutoverEventId: number
  snapshotSeq: number
  state: 'hydrating' | 'live'
  bufferedEvents: MobileStreamEvent[]
  needsResync: boolean
}

type MobileEventClient = {
  response: ServerResponse
  deviceId: string
  subscriptions: Map<string, SessionSubscription>
}

type SessionAddress = { kind: 'session'; sessionId: string }
  | { kind: 'subagent'; parentSessionId: string; childSessionId: string; mode: 'one-shot' | 'continuable' }

type UpstreamStream = 'events' | 'control' | 'workspace'

const MOBILE_WRITABLE_SETTINGS = new Set(['ui-theme', 'locale', 'ui-conversation', 'agent-presets', 'permission'])

/** Provides a narrow HTTP API for paired native clients over one local DSH runtime. */
export class MobileGateway {
  readonly #dsh: DshLoopbackClient
  readonly #devices: MobileDeviceRegistry
  readonly #host: string
  readonly #port: number
  #server: Server | undefined
  #status: MobileGatewayStatus | undefined
  #eventsAbort: AbortController | undefined
  #eventsRetry: ReturnType<typeof setTimeout> | undefined
  /** Consecutive failed opens per upstream, driving the retry backoff. */
  #streamFailures: Record<UpstreamStream, number> = { events: 0, control: 0, workspace: 0 }
  #controlAbort: AbortController | undefined
  #controlRetry: ReturnType<typeof setTimeout> | undefined
  #workspaceAbort: AbortController | undefined
  #workspaceRetry: ReturnType<typeof setTimeout> | undefined
  readonly #follows = new Map<string, { controller: AbortController }>()
  #clientId: string | undefined
  #nextEventId = 0
  #eventHeartbeat: ReturnType<typeof setInterval> | undefined
  readonly #eventClients = new Map<ServerResponse, MobileEventClient>()
  readonly #subscriptions = new Map<string, SessionSubscription>()
  readonly #pairings = new Map<string, PendingPairing>()
  readonly #pending = new Map<string, PendingInteraction>()
  // `session/queue` and `session/jobs` are authoritative live snapshots carried
  // by the DSH control stream. They are never reconstructed from durable
  // history or written back by the mobile client.
  readonly #queues = new Map<string, unknown[]>()
  readonly #jobs = new Map<string, unknown[]>()
  // Per-session projection hints cached from control baselines, projection
  // updates, and one-shot follow snapshots. Backs model reads and titles.
  readonly #projections = new Map<string, Record<string, unknown>>()
  // Workspaces cached from the DSH workspace follow stream.
  #workspaces: DshWorkspaceList = { items: [], archivedSessionIds: [] }
  /** Sessions the desktop pinned; carried through for the drawer's ordering. */
  #pinnedSessionIds: readonly string[] = []

  /** @param options - Loopback DSH and local listener configuration. */
  constructor(options: MobileGatewayOptions) {
    this.#devices = options.devices ?? new MobileDeviceRegistry()
    this.#dsh = options.wireClient ?? new DshLoopbackClient(requireDshUrl(options), options.cookie, options.cookieProvider)
    this.#host = options.host ?? LOOPBACK_HOST
    this.#port = options.port ?? 0
    if (this.#host !== LOOPBACK_HOST && this.#host !== 'localhost') {
      throw new Error('The Mobile Gateway only permits a loopback listener.')
    }
  }

  /**
   * Starts the loopback HTTP listener once.
   * @returns The existing or newly bound listener URL.
   * @throws {Error} When the listener cannot bind a TCP address.
   */
  async start(): Promise<MobileGatewayStatus> {
    if (this.#status !== undefined) return this.#status
    const server = createServer((request, response) => {
      void this.#handle(request, response).catch((error: unknown) => {
        writeError(response, toGatewayError(error))
      })
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.#port, this.#host, () => {
        resolve()
      })
    })
    const address = server.address()
    if (address === null || typeof address === 'string') {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => {
          if (error === undefined) resolve()
          else reject(error)
        }),
      )
      throw new Error('The Mobile Gateway did not receive a TCP listener address.')
    }
    this.#server = server
    const status = { url: `http://${this.#host}:${address.port}` }
    this.#status = status
    this.#startUpstream()
    return status
  }

  /**
   * Stops the listener, ends live event streams, and clears transient device state.
   * @returns A promise fulfilled after the HTTP server closes.
   */
  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    this.#status = undefined
    this.#stopUpstream()
    for (const client of this.#eventClients.values()) client.response.end()
    this.#eventClients.clear()
    this.#subscriptions.clear()
    this.#stopEventHeartbeat()
    this.#pairings.clear()
    this.#pending.clear()
    this.#queues.clear()
    this.#jobs.clear()
    this.#projections.clear()
    this.#workspaces = { items: [], archivedSessionIds: [] }
    if (server === undefined) return
    await new Promise<void>((resolve, reject) =>
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      }),
    )
  }

  /**
   * Creates a durable credential after desktop pairing confirms a device label.
   * @param label - Human-readable device label shown in desktop settings.
   * @returns The new device credential, including its bearer token.
   */
  pairDevice(label: string): MobileDeviceCredential {
    return this.#devices.create(label)
  }

  /**
   * Creates a short-lived, single-use secret that a mobile QR scan exchanges for a device credential.
   * @param label - Human-readable device label reserved for the redeemed credential.
   * @returns Pairing identifier, secret, and expiry timestamp for the QR payload.
   * @throws {Error} When the label is empty or exceeds the allowed length.
   */
  createPairing(label: string): { pairingId: string; pairingSecret: string; expiresAt: string } {
    const normalizedLabel = label.trim()
    if (normalizedLabel.length === 0 || normalizedLabel.length > 120)
      throw new Error('A paired device label must contain between 1 and 120 characters.')
    this.#prunePairings()
    const pairingId = randomBytes(18).toString('base64url')
    const pairingSecret = randomBytes(32).toString('base64url')
    const expiresAt = Date.now() + PAIRING_TTL_MS
    this.#pairings.set(pairingId, { label: normalizedLabel, secretHash: pairingSecretHash(pairingSecret), expiresAt })
    return { pairingId, pairingSecret, expiresAt: new Date(expiresAt).toISOString() }
  }

  /**
   * Exchanges one unexpired pairing secret for a durable paired-device credential.
   * @param pairingId - Identifier issued with the QR pairing payload.
   * @param pairingSecret - Single-use secret supplied by the scanned QR payload.
   * @returns The new device credential, including its bearer token.
   * @throws {GatewayHttpError} When the pairing is absent, expired, used, or invalid.
   */
  redeemPairing(pairingId: string, pairingSecret: string): MobileDeviceCredential {
    this.#prunePairings()
    const pairing = this.#pairings.get(pairingId)
    if (pairing === undefined) throw new GatewayHttpError('pairing-not-found', '配对码无效或已被使用，请重新扫描桌面端二维码。')
    const candidate = pairingSecretHash(pairingSecret)
    if (candidate.byteLength !== pairing.secretHash.byteLength || !timingSafeEqual(candidate, pairing.secretHash))
      throw new GatewayHttpError('unauthorized', '配对码无效，请重新扫描桌面端二维码。')
    this.#pairings.delete(pairingId)
    return this.#devices.create(pairing.label)
  }

  /**
   * Lists paired devices for the desktop settings surface.
   * @returns Immutable device records without bearer tokens.
   */
  pairedDevices(): readonly MobileDevice[] {
    return this.#devices.list()
  }

  /**
   * Revokes a paired device immediately.
   * @param deviceId - Durable identifier of the device to revoke.
   * @returns `true` when an existing device was revoked.
   */
  revokeDevice(deviceId: string): boolean {
    return this.#devices.revoke(deviceId)
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method === 'GET' && request.url === '/v1/health') {
      writeJson(response, 200, { contractVersion: 1, status: 'ok' })
      return
    }
    const url = new URL(request.url ?? '/', 'http://mobile-gateway.local')
    if (request.method === 'POST' && url.pathname === '/v1/pairing/redeem') {
      if (request.headers['content-type'] !== 'application/json')
        throw new GatewayHttpError('bad-request', '配对请求必须使用 JSON。')
      const body = await readJson(request)
      const pairingId = requireText(body.pairingId, '缺少配对标识。')
      const pairingSecret = requireText(body.pairingSecret, '缺少配对密钥。')
      writeJson(response, 200, await this.#response(this.redeemPairing(pairingId, pairingSecret)))
      return
    }
    const device = this.#devices.authenticate(request.headers.authorization)
    if (device === undefined) {
      writeError(response, { code: 'unauthorized', message: '需要已配对的移动设备凭据。' })
      return
    }
    if (request.method === 'GET' && url.pathname === '/v1/events') {
      this.#ensureUpstream()
      this.#openEventStream(response, device.deviceId)
      return
    }
    if (request.method !== 'POST' || request.headers['content-type'] !== 'application/json') {
      writeError(response, { code: 'bad-request', message: '移动端 API 请求必须使用 JSON POST。' })
      return
    }
    const body = await readJson(request)
    const subscription = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subscriptions$/)
    if (subscription !== null) {
      const sessionId = decodePathSegment(subscription)
      writeJson(response, 200, await this.#response(this.#createSessionSubscription(device.deviceId, sessionId, body)))
      return
    }
    const activation = url.pathname.match(/^\/v1\/subscriptions\/([^/]+)\/activate$/)
    if (activation !== null) {
      const subscriptionId = decodePathSegment(activation)
      const activationToken = requireText(body.activationToken, '缺少订阅激活令牌。')
      const appliedSnapshotSeq = optionalNonnegativeInteger(body.appliedSnapshotSeq, '快照水位线必须是非负整数。')
      if (appliedSnapshotSeq === undefined) throw new GatewayHttpError('bad-request', '缺少快照水位线。')
      const subscription = this.#activateSessionSubscription(
        device.deviceId,
        subscriptionId,
        activationToken,
        appliedSnapshotSeq,
      )
      writeJson(response, 200, await this.#response(subscription))
      return
    }
    const pending = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/interactions$/)
    if (pending !== null) {
      this.#ensureUpstream()
      const sessionId = decodePathSegment(pending)
      const items = [...this.#pending.values()].filter(item => item.sessionId === sessionId)
      writeJson(response, 200, await this.#response({ items }))
      return
    }
    if (url.pathname === '/v1/sessions/search') {
      const query = requireText(body.query, '搜索词不能为空。')
      if (query.length > MAX_SESSION_SEARCH_CHARS || query.includes('\0'))
        throw new GatewayHttpError('bad-request', '搜索词无效或过长。')
      writeJson(response, 200, await this.#response(await this.#dsh.call('session/search', { request: { query } })))
      return
    }
    if (url.pathname === '/v1/sessions/running') {
      const summary = await this.#dsh.call<DshSessionList>('session/list', { _request: {} })
      writeJson(
        response,
        200,
        await this.#response({
          sessionIds: (summary.items ?? []).filter(item => item.running === true).map(item => item.sessionId),
        }),
      )
      return
    }
    if (url.pathname === '/v1/sessions/list') {
      this.#ensureUpstream()
      const [summary, sessionList] = await Promise.all([
        this.#dsh.call<DshSessionList>('session/list', { _request: {} }),
        Promise.resolve(this.#workspaces),
      ])
      writeJson(
        response,
        200,
        await this.#response({
          ...summary,
          items: (summary.items ?? []).map(item => withVisibleSessionMetadata(item, this.#projections.get(item.sessionId))),
          workspaces: mobileWorkspaces(sessionList.items),
          archivedSessionIds: sessionList.archivedSessionIds ?? [],
        }),
      )
      return
    }
    if (url.pathname === '/v1/sessions/create') {
      const workspaceId = optionalText(body.workspaceId)
      const cwd = optionalText(body.cwd)
      if (workspaceId !== undefined && cwd !== undefined)
        throw new GatewayHttpError('bad-request', '新会话只能指定工作区或目录。')
      const agentPreset = optionalText(body.agentPreset)
      const value = await this.#dsh.call<{ sessionId: string; agentPreset?: string }>('session/create', {
        request: {
          ...(workspaceId === undefined ? {} : { workspaceId }),
          ...(cwd === undefined ? {} : { cwd }),
          ...(agentPreset === undefined ? {} : { agentPreset }),
        },
      })
      writeJson(response, 200, await this.#response(value))
      return
    }
    if (url.pathname === '/v1/settings/describe') {
      writeJson(response, 200, await this.#response(await this.#dsh.call('settings/describe', {})))
      return
    }
    if (url.pathname === '/v1/settings/update') {
      const ns = requireText(body.ns, '设置命名空间不能为空。')
      if (!MOBILE_WRITABLE_SETTINGS.has(ns)) throw new GatewayHttpError('bad-request', '此设置只能在桌面端修改。')
      const patch = requireObject(body.patch, '设置修改必须是 JSON 对象。')
      const expectedRevision = optionalRevision(body.expectedRevision)
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('settings/update', {
            ns,
            patch,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          }),
        ),
      )
      return
    }
    if (url.pathname === '/v1/settings/mutate') {
      const ns = requireText(body.ns, '设置命名空间不能为空。')
      if (!MOBILE_WRITABLE_SETTINGS.has(ns)) throw new GatewayHttpError('bad-request', '此设置只能在桌面端修改。')
      const ops = requireArray(body.ops, '设置修改操作必须是数组。')
      const expectedRevision = optionalRevision(body.expectedRevision)
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('settings/mutate', {
            ns,
            ops,
            ...(expectedRevision === undefined ? {} : { expectedRevision }),
          }),
        ),
      )
      return
    }
    if (url.pathname === '/v1/llm/providers') {
      const providers = await this.#dsh.call('llm/listConfigurableProviders', {})
      writeJson(response, 200, await this.#response({ providers }))
      return
    }
    if (url.pathname === '/v1/llm/models') {
      const catalog = await this.#dsh.call<DshModelCatalog>('session/modelCatalog', {})
      writeJson(response, 200, await this.#response({ groups: catalog.groups ?? [], failures: catalog.failures ?? [] }))
      return
    }
    if (url.pathname === '/v1/agent-presets/list') {
      const roster = await this.#dsh.call<{ presets?: unknown; authorable?: boolean }>('agentPresets/list', {})
      writeJson(
        response,
        200,
        await this.#response({
          presets: roster.presets ?? [],
          authorable: roster.authorable === true,
          hasDocument: false,
        }),
      )
      return
    }
    if (url.pathname === '/v1/agent-presets/read') {
      const agentPreset = requireText(body.agentPreset, 'Agent 预设不能为空。')
      // The host descriptor names its argument `agentPreset` and answers with the
      // document itself, so the route forwards the composed content unchanged.
      const document = await this.#dsh.call<{
        agentPreset?: unknown
        content?: unknown
        name?: unknown
        description?: unknown
      }>('agentPresets/read', { agentPreset })
      const content = typeof document.content === 'string' ? document.content : ''
      writeJson(
        response,
        200,
        await this.#response({
          agentPreset,
          content,
          ...(typeof document.name === 'string' ? { name: document.name } : {}),
          ...(typeof document.description === 'string' ? { description: document.description } : {}),
        }),
      )
      return
    }
    const queueSnapshot = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/queue$/)
    if (queueSnapshot !== null) {
      this.#ensureUpstream()
      const sessionId = decodePathSegment(queueSnapshot)
      writeJson(response, 200, await this.#response({ items: this.#queues.get(sessionId) ?? [] }))
      return
    }
    const jobs = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/jobs$/)
    if (jobs !== null) {
      this.#ensureUpstream()
      const sessionId = decodePathSegment(jobs)
      writeJson(response, 200, await this.#response({ items: this.#jobs.get(sessionId) ?? [] }))
      return
    }
    const subagentHistory = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)\/history$/)
    if (subagentHistory !== null) {
      const parentSessionId = decodePathSegment(subagentHistory)
      const childSessionId = decodePathSegmentAt(subagentHistory, 2, '子 Agent 路径无效。')
      const mode = requireSubagentMode(body.mode)
      const beforeSeq = optionalNonnegativeInteger(body.beforeSeq, '历史游标必须是非负整数。')
      const maxMessages = optionalPositiveInteger(body.maxMessages, '历史消息数量必须是正整数。')
      const value = await this.#readHistoryPage(
        { kind: 'subagent', parentSessionId, childSessionId, mode },
        beforeSeq,
        maxMessages,
      )
      writeJson(response, 200, await this.#response(value))
      return
    }
    const promptSubagent = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)\/messages$/)
    if (promptSubagent !== null) {
      const parentSessionId = decodePathSegment(promptSubagent)
      const childSessionId = decodePathSegmentAt(promptSubagent, 2, '子 Agent 路径无效。')
      if (requireSubagentMode(body.mode) !== 'continuable')
        throw new GatewayHttpError('bad-request', '只有可继续的子 Agent 可以接收消息。')
      const content = readPromptContent(body)
      const clientTimeZone = optionalText(body.clientTimeZone)
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('subagents/prompt', {
            request: {
              requestId: randomUUID(),
              parentSessionId,
              childSessionId,
              mode: 'continuable',
              delivery: 'queue',
              content,
              ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
            },
          }),
        ),
      )
      return
    }
    const interruptSubagent = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents\/([^/]+)\/interrupt$/)
    if (interruptSubagent !== null) {
      const parentSessionId = decodePathSegment(interruptSubagent)
      const childSessionId = decodePathSegmentAt(interruptSubagent, 2, '子 Agent 路径无效。')
      if (requireSubagentMode(body.mode) !== 'continuable')
        throw new GatewayHttpError('bad-request', '只有可继续的子 Agent 可以停止。')
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('subagents/interruptByParent', { childSessionId, parentSessionId, mode: 'continuable' }),
        ),
      )
      return
    }
    const subagents = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/subagents$/)
    if (subagents !== null) {
      const parentSessionId = decodePathSegment(subagents)
      writeJson(response, 200, await this.#response(await this.#dsh.call('subagents/list', { parentSessionId })))
      return
    }
    if (url.pathname === '/v1/schedules/catalog') {
      writeJson(response, 200, await this.#response({ items: await this.#dsh.call('schedule/catalog', {}) }))
      return
    }
    const schedule = url.pathname.match(/^\/v1\/schedules\/([^/]+)\/(pause|resume|delete)$/)
    if (schedule !== null) {
      const id = decodePathSegment(schedule)
      const expectedUpdatedAt = body.expectedUpdatedAt
      if (expectedUpdatedAt !== null && typeof expectedUpdatedAt !== 'string') throw new GatewayHttpError('bad-request', '缺少任务版本，请刷新后重试。')
      const request = schedule[2] === 'delete'
        ? { id, action: 'delete', expectedUpdatedAt }
        : { id, action: 'update', patch: { active: schedule[2] === 'resume' }, expectedUpdatedAt }
      writeJson(response, 200, await this.#response(await this.#dsh.call('schedule/edit', { request })))
      return
    }
    const readGoal = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal\/read$/)
    if (readGoal !== null) {
      const current = await this.#dsh.call('goals/get', { agentId: decodePathSegment(readGoal) })
      writeJson(response, 200, await this.#response({ goal: current ?? null }))
      return
    }
    const createGoal = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal\/create$/)
    if (createGoal !== null) {
      const objective = requireText(body.objective, '目标内容不能为空。')
      writeJson(response, 200, await this.#response(await this.#dsh.call('goals/create', {
        agentId: decodePathSegment(createGoal), request: { objective },
      })))
      return
    }
    const goal = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/goal\/(edit|pause|resume|clear)$/)
    if (goal !== null) {
      const sessionId = decodePathSegment(goal)
      const action = goal[2]
      const ref = requireGoalRef(body.ref)
      const scopedArgs = { agentId: sessionId, ref } as Record<string, unknown>
      if (action === 'edit') {
        const objective = requireText(body.objective, '目标内容不能为空。')
        writeJson(response, 200, await this.#response(await this.#dsh.call('goals/edit', { ...scopedArgs, request: { objective } })))
        return
      }
      if (action === 'pause' || action === 'resume' || action === 'clear') {
        writeJson(response, 200, await this.#response(await this.#dsh.call(`goals/${action}`, scopedArgs)))
        return
      }
      throw new GatewayHttpError('not-found', '未找到请求的移动端操作。')
    }
    const renameWorkspace = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/rename$/)
    if (renameWorkspace !== null) {
      const title = requireText(body.title, '工作区名称不能为空。')
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('workspace/rename', { request: { workspaceId: decodePathSegment(renameWorkspace), title } }),
        ),
      )
      return
    }
    const deleteWorkspace = url.pathname.match(/^\/v1\/workspaces\/([^/]+)\/delete$/)
    if (deleteWorkspace !== null) {
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('workspace/delete', { request: { workspaceId: decodePathSegment(deleteWorkspace) } }),
        ),
      )
      return
    }
    const history = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/history$/)
    if (history !== null) {
      const beforeSeq = optionalNonnegativeInteger(body.beforeSeq, '历史游标必须是非负整数。')
      const maxMessages = optionalPositiveInteger(body.maxMessages, '历史消息数量必须是正整数。')
      const value = await this.#readHistoryPage({ kind: 'session', sessionId: decodePathSegment(history) }, beforeSeq, maxMessages)
      writeJson(response, 200, await this.#response(value))
      return
    }
    const events = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/events$/)
    if (events !== null) {
      const since = typeof body.since === 'number' && Number.isInteger(body.since) && body.since >= 0 ? body.since : 0
      const sessionId = decodePathSegment(events)
      const value = await this.#readHistoryPage({ kind: 'session', sessionId }, undefined, undefined)
      const items = toMobileHistoryItems(value.events).filter(item => typeof item.seq !== 'number' || item.seq > since)
      const summary = await this.#dsh.call<DshSessionList>('session/list', { _request: {} })
      const running = summary.items?.some(item => item.sessionId === sessionId && item.running === true) === true
      const status = [...this.#pending.values()].some(item => item.sessionId === sessionId)
        ? 'waiting'
        : running ? 'running' : inferSessionStatus(items)
      writeJson(response, 200, await this.#response({ since, items, status }))
      return
    }
    const rename = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/rename$/)
    if (rename !== null) {
      const title = requireText(body.title, '会话标题不能为空。')
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('session/rename', { request: { sessionId: decodePathSegment(rename), title } }),
        ),
      )
      return
    }
    const fork = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/fork$/)
    if (fork !== null) {
      const atSeq = optionalNonnegativeInteger(body.atSeq, '分叉位置必须是非负整数。')
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('session/fork', {
            request: {
              sessionId: decodePathSegment(fork),
              ...(atSeq === undefined ? {} : { atSeq }),
            },
          }),
        ),
      )
      return
    }
    const unarchive = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/unarchive$/)
    if (unarchive !== null) {
      writeJson(response, 200, await this.#response(await this.#dsh.call('workspace/unarchiveSession', {
        request: { sessionId: decodePathSegment(unarchive) },
      })))
      return
    }
    const archive = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/archive$/)
    if (archive !== null) {
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('workspace/archiveSession', { request: { sessionId: decodePathSegment(archive) } }),
        ),
      )
      return
    }
    const attachment = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/attachments\/([^/]+)$/)
    if (attachment !== null) {
      const sessionId = decodeURIComponent(attachment[1] ?? '')
      const attachmentId = decodeURIComponent(attachment[2] ?? '')
      if (sessionId === '' || attachmentId === '') throw new GatewayHttpError('bad-request', '附件路径无效。')
      writeJson(
        response,
        200,
        await this.#response(await this.#dsh.call('session/attachment', { request: { sessionId, attachmentId } })),
      )
      return
    }
    const updateQueue = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/queue\/([^/]+)$/)
    if (updateQueue !== null) {
      const sessionId = decodeURIComponent(updateQueue[1] ?? '')
      const itemId = decodeURIComponent(updateQueue[2] ?? '')
      if (sessionId === '' || itemId === '') throw new GatewayHttpError('bad-request', '队列路径无效。')
      const action = requireObject(body.action, '队列操作不能为空。')
      writeJson(
        response,
        200,
        await this.#response(await this.#dsh.call('session/updateQueue', { request: { sessionId, itemId, action } })),
      )
      return
    }
    const models = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/models$/)
    if (models !== null) {
      const sessionId = decodePathSegment(models)
      const catalog = await this.#dsh.call<DshModelCatalog>('session/modelCatalog', {})
      writeJson(
        response,
        200,
        await this.#response({
          current: this.#projectedModelSelection(sessionId) ?? catalog.default,
          routable: catalog.routableProviders ?? [],
          groups: catalog.groups ?? [],
          failures: catalog.failures ?? [],
        }),
      )
      return
    }
    const selectModel = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/model$/)
    if (selectModel !== null) {
      const provider = requireText(body.provider, '模型提供方不能为空。')
      const model = requireText(body.model, '模型不能为空。')
      const reasoningEffort = optionalText(body.reasoningEffort)
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('session/selectModel', {
            request: {
              sessionId: decodePathSegment(selectModel),
              provider,
              model,
              ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            },
          }),
        ),
      )
      return
    }
    const selectPreset = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/agent-preset$/)
    if (selectPreset !== null) {
      const agentPreset = requireText(body.agentPreset, 'Agent 预设不能为空。')
      const selected = await this.#dsh.call<string>('agentPresets/select', {
        agentId: decodePathSegment(selectPreset),
        agentPreset,
      })
      writeJson(response, 200, await this.#response({ agentPreset: selected }))
      return
    }
    const prompt = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/messages$/)
    if (prompt !== null) {
      const content = readPromptContent(body)
      const clientTimeZone = optionalText(body.clientTimeZone)
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('session/prompt', {
            request: {
              requestId: randomUUID(),
              sessionId: decodePathSegment(prompt),
              mode: 'queue',
              content,
              ...(clientTimeZone === undefined ? {} : { clientTimeZone }),
            },
          }),
        ),
      )
      return
    }
    const cancellation = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/cancel$/)
    if (cancellation !== null) {
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('session/cancel', { request: { sessionId: decodePathSegment(cancellation) } }),
        ),
      )
      return
    }
    if (url.pathname === '/v1/interactions/respond') {
      const rpcId = typeof body.rpcId === 'string' ? body.rpcId : ''
      const interaction = this.#pending.get(rpcId)
      if (interaction === undefined || !isExpectedInteractionResponse(interaction, body.result)) {
        throw new GatewayHttpError('bad-request', '响应与当前的权限或问题请求不匹配。')
      }
      const receipt = await this.#answerInteraction(interaction, body.result)
      this.#pending.delete(rpcId)
      this.#broadcast(interaction.type === 'approval/requested'
        ? {
          contractVersion: 1,
          eventId: this.#nextStreamEventId(),
          type: 'approval/resolved',
          payload: { approvalId: rpcId },
          rpcId,
          sessionId: interaction.sessionId,
        }
        : {
          contractVersion: 1,
          eventId: this.#nextStreamEventId(),
          type: 'question/resolved',
          payload: { questionRpcId: rpcId },
          rpcId,
          sessionId: interaction.sessionId,
        })
      writeJson(response, 200, await this.#response(receipt))
      return
    }
    const feedback = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/feedback\/(list|put|delete)$/)
    if (feedback !== null) {
      const action = feedback[2]
      if (action === 'list') {
        writeJson(
          response,
          200,
          await this.#response(await this.#dsh.call('messageFeedback/list', { request: { sessionId: decodePathSegment(feedback) } })),
        )
        return
      }
      if (action === 'put') {
        const messageId = requireText(body.messageId, '消息标识不能为空。')
        const rating = body.rating === 'positive' || body.rating === 'negative' || typeof body.rating === 'string'
          ? body.rating
          : undefined
        if (rating === undefined) throw new GatewayHttpError('bad-request', '反馈评级无效。')
        const note = optionalText(body.note)
        const ifVersion = body.ifVersion === null || typeof body.ifVersion === 'string' ? body.ifVersion : undefined
        writeJson(
          response,
          200,
          await this.#response(
            await this.#dsh.call('messageFeedback/put', {
              request: {
                sessionId: decodePathSegment(feedback),
                messageId,
                rating,
                ...(note === undefined ? {} : { note }),
                ifVersion: ifVersion ?? null,
              },
            }),
          ),
        )
        return
      }
      const messageId = requireText(body.messageId, '消息标识不能为空。')
      const ifVersion = typeof body.ifVersion === 'string' ? body.ifVersion : undefined
      if (ifVersion === undefined) throw new GatewayHttpError('bad-request', '缺少反馈版本。')
      writeJson(
        response,
        200,
        await this.#response(
          await this.#dsh.call('messageFeedback/delete', { request: { sessionId: decodePathSegment(feedback), messageId, ifVersion } }),
        ),
      )
      return
    }
    writeError(response, { code: 'not-found', message: '未找到请求的移动端操作。' })
  }

  /**
   * Reads one message-aligned history page for a durable address without a
   * live follow. The one-shot follow snapshot supplies the log cursor, and
   * backward pages read through `session/page`.
   * @param address - Durable session or subagent address.
   * @param beforeSeq - Exclusive upper bound for older pages, when given.
   * @param maxMessages - Message-aligned window budget, when given.
   * @returns Mobile history items with pagination metadata.
   */
  async #readHistoryPage(
    address: SessionAddress,
    beforeSeq: number | undefined,
    maxMessages: number | undefined,
  ): Promise<{ events: DshHistoryRecord[]; hasMore?: boolean; projections?: unknown; items: MobileHistoryItem[] }> {
    const controller = new AbortController()
    try {
      for await (const frame of this.#dsh.open(
        'session/follow',
        { request: { address, ...(maxMessages === undefined ? {} : { maxMessages }) } },
        controller.signal,
      )) {
        const snapshot = frame as DshFollowSnapshot
        if (snapshot.type !== 'snapshot') break
        const cursor = snapshot.cursor
        if (beforeSeq === undefined || typeof cursor !== 'number') {
          return {
            events: snapshot.records ?? [],
            ...(snapshot.hasMore === undefined ? {} : { hasMore: snapshot.hasMore }),
            ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
            items: toMobileHistoryItems(snapshot.records ?? []),
          }
        }
        const page = await this.#dsh.call<DshPage>('session/page', {
          request: { address, throughSeq: cursor, beforeSeq, ...(maxMessages === undefined ? {} : { maxMessages }) },
        })
        return {
          events: page.records ?? [],
          ...(page.hasMore === undefined ? {} : { hasMore: page.hasMore }),
          ...(snapshot.projections === undefined ? {} : { projections: snapshot.projections }),
          items: toMobileHistoryItems(page.records ?? []),
        }
      }
    } finally {
      controller.abort()
    }
    throw new DshLoopbackError('upstream-unavailable', 'DSH 会话流在返回快照前已关闭。')
  }

  /**
   * Reads the durable model-selection projection for one session, falling back
   * to a one-shot follow snapshot when the control cache has no entry.
   * @param sessionId - Session whose selection is read.
   * @returns The current selection, or `undefined` when the log has none.
   */
  #projectedModelSelection(sessionId: string): DshModelSelection | undefined {
    const values = this.#projections.get(sessionId)
    const selection = values?.modelSelection
    if (selection !== null && typeof selection === 'object' && !Array.isArray(selection)) {
      const view = selection as { lastUsed?: DshModelSelection | null; next?: DshModelSelection | null }
      return view.next ?? view.lastUsed ?? undefined
    }
    return undefined
  }

  #startUpstream(): void {
    if (this.#status === undefined) return
    if (this.#eventsAbort === undefined) {
      const controller = new AbortController()
      this.#eventsAbort = controller
      void this.#captureEvents(controller)
    }
    if (this.#controlAbort === undefined) {
      const controller = new AbortController()
      this.#controlAbort = controller
      void this.#captureControl(controller)
    }
    if (this.#workspaceAbort === undefined) {
      const controller = new AbortController()
      this.#workspaceAbort = controller
      void this.#captureWorkspaces(controller)
    }
  }

  /** Re-arms any upstream stream that is not currently capturing. */
  #ensureUpstream(): void {
    this.#startUpstream()
  }

  #stopUpstream(): void {
    this.#eventsAbort?.abort()
    this.#eventsAbort = undefined
    if (this.#eventsRetry !== undefined) clearTimeout(this.#eventsRetry)
    this.#eventsRetry = undefined
    this.#controlAbort?.abort()
    this.#controlAbort = undefined
    if (this.#controlRetry !== undefined) clearTimeout(this.#controlRetry)
    this.#controlRetry = undefined
    this.#workspaceAbort?.abort()
    this.#workspaceAbort = undefined
    if (this.#workspaceRetry !== undefined) clearTimeout(this.#workspaceRetry)
    this.#workspaceRetry = undefined
    for (const follow of this.#follows.values()) follow.controller.abort()
    this.#follows.clear()
    this.#clientId = undefined
  }

  async #captureEvents(controller: AbortController): Promise<void> {
    try {
      for await (const frame of this.#dsh.openEvents(controller.signal)) {
        this.#streamFailures.events = 0
        this.#handleEventFrame(frame)
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error('[mobile-gateway] DSH event subscription ended:', error)
    } finally {
      if (this.#eventsAbort === controller) {
        this.#eventsAbort = undefined
        this.#clientId = undefined
        this.#scheduleUpstreamRestart('events', controller.signal.aborted)
      }
    }
  }

  async #captureControl(controller: AbortController): Promise<void> {
    try {
      for await (const frame of this.#dsh.open('session/control', {}, controller.signal)) {
        this.#streamFailures.control = 0
        this.#handleControlFrame(frame as DshControlFrame)
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error('[mobile-gateway] DSH control subscription ended:', error)
    } finally {
      if (this.#controlAbort === controller) {
        this.#controlAbort = undefined
        this.#scheduleUpstreamRestart('control', controller.signal.aborted)
      }
    }
  }

  async #captureWorkspaces(controller: AbortController): Promise<void> {
    try {
      for await (const frame of this.#dsh.open('workspace/follow', {}, controller.signal)) {
        this.#streamFailures.workspace = 0
        this.#handleWorkspaceFrame(frame as DshWorkspaceFrame)
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error('[mobile-gateway] DSH workspace subscription ended:', error)
    } finally {
      if (this.#workspaceAbort === controller) {
        this.#workspaceAbort = undefined
        this.#scheduleUpstreamRestart('workspace', controller.signal.aborted)
      }
    }
  }

  #scheduleUpstreamRestart(stream: UpstreamStream, aborted: boolean): void {
    if (aborted || this.#status === undefined) return
    const existing = stream === 'events' ? this.#eventsRetry : stream === 'control' ? this.#controlRetry : this.#workspaceRetry
    if (existing !== undefined) return
    // A fixed one-second retry re-minted a credential per attempt, and every
    // credential is a host peer that outlives the attempt. Backing off keeps a
    // failing stream from filling the host's peer table.
    const attempt = this.#streamFailures[stream] + 1
    this.#streamFailures[stream] = attempt
    const delay = Math.min(1_000 * 2 ** (attempt - 1), 30_000)
    const retry = setTimeout(() => {
      if (stream === 'events') this.#eventsRetry = undefined
      else if (stream === 'control') this.#controlRetry = undefined
      else this.#workspaceRetry = undefined
      this.#startUpstream()
    }, delay)
    retry.unref()
    if (stream === 'events') this.#eventsRetry = retry
    else if (stream === 'control') this.#controlRetry = retry
    else this.#workspaceRetry = retry
  }

  #handleEventFrame(value: Record<string, unknown>): void {
    const frame = value as DshEventFrame
    if (frame.type === 'ready') {
      this.#clientId = typeof frame.clientId === 'string' ? frame.clientId : undefined
      return
    }
    if (frame.type === 'emit') this.#handleForwardedEmit(frame.event, frame.args ?? [])
    else if (frame.type === 'waterfall') this.#rememberWaterfall(frame)
    else this.#resolveWaterfallCancellation(frame.eventId)
  }

  /** Projects one forwarded Host emit onto the mobile SSE contract. */
  #handleForwardedEmit(event: string | undefined, args: unknown[]): void {
    if (event === 'api-session/added') {
      const summary = args[0]
      if (summary === null || typeof summary !== 'object' || Array.isArray(summary)) return
      const record = summary as DshSessionSummary
      const sessionId = typeof record.sessionId === 'string' ? record.sessionId : undefined
      if (sessionId === undefined) return
      if (record.projections?.values !== undefined) this.#projections.set(sessionId, record.projections.values)
      this.#broadcast({
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'host/session-added',
        payload: { sessionId },
        sessionId,
      })
      return
    }
    if (event === 'api-session/removed') {
      const sessionId = typeof args[0] === 'string' ? args[0] : undefined
      if (sessionId === undefined) return
      this.#projections.delete(sessionId)
      this.#broadcast({
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'host/session-removed',
        payload: { sessionId },
        sessionId,
      })
      return
    }
    if (event === 'api-session/status') {
      const sessionId = typeof args[0] === 'string' ? args[0] : undefined
      const running = args[1] === true
      if (sessionId === undefined) return
      this.#broadcast({
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'host/session-status',
        payload: { running },
        sessionId,
      })
      return
    }
    // Remaining forwarded emits (cordis/*, settings, commands, credentials,
    // llm, preset selection) have no mobile consumer; the bridge's default
    // invalidation covers them through the events above.
  }

  /** Registers one Host waterfall delivery as a pending mobile interaction. */
  #rememberWaterfall(frame: DshEventFrame): void {
    if (frame.type !== 'waterfall') return
    const eventId = frame.eventId
    const sessionId = frame.agentId
    if (typeof eventId !== 'string' || typeof sessionId !== 'string') return
    const request = frame.request ?? {}
    let pending: PendingInteraction
    if (frame.event === 'approval/request') {
      const toolName = typeof request.toolName === 'string' ? request.toolName : ''
      pending = {
        rpcId: eventId,
        type: 'approval/requested',
        sessionId,
        payload: {
          type: 'approval/requested',
          sessionId,
          approvalId: eventId,
          toolName,
          ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
          ...(typeof request.reason === 'string' ? { reason: request.reason } : {}),
        },
        receivedAt: new Date().toISOString(),
      }
    } else if (frame.event === 'user-questions/request') {
      pending = {
        rpcId: eventId,
        type: 'question/requested',
        sessionId,
        payload: { type: 'question/requested', sessionId, questions: request.questions },
        receivedAt: new Date().toISOString(),
      }
    } else {
      // Other waterfall events have no mobile claimant; delegating releases
      // the Host chain exactly like a web client without a listener.
      void this.#dsh
        .answerEvent({ clientId: this.#clientId, eventId, outcome: { kind: 'next' } })
        .catch(() => {})
      return
    }
    this.#pending.set(eventId, pending)
    this.#broadcast({
      contractVersion: 1,
      eventId: this.#nextStreamEventId(),
      type: pending.type,
      payload: pending.payload,
      rpcId: eventId,
      sessionId,
    })
  }

  /** Drops the pending interaction for one Host cancellation and notifies devices. */
  #resolveWaterfallCancellation(eventId: string | undefined): void {
    if (typeof eventId !== 'string') return
    const interaction = this.#pending.get(eventId)
    if (interaction === undefined) return
    this.#pending.delete(eventId)
    this.#broadcast(interaction.type === 'approval/requested'
      ? {
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'approval/resolved',
        payload: { approvalId: eventId },
        rpcId: eventId,
        sessionId: interaction.sessionId,
      }
      : {
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'question/resolved',
        payload: { questionRpcId: eventId },
        rpcId: eventId,
        sessionId: interaction.sessionId,
      })
  }

  /**
   * Translates one validated mobile interaction response into a Host Remote
   * event result and answers the pending waterfall delivery.
   * @param interaction - The pending interaction being answered.
   * @param result - The mobile `respond` result envelope.
   * @returns The Host's acceptance receipt.
   */
  async #answerInteraction(interaction: PendingInteraction, result: unknown): Promise<unknown> {
    const response = result as { ok?: boolean; value?: Record<string, unknown>; error?: Record<string, unknown> }
    const clientId = this.#clientId
    if (typeof clientId !== 'string') throw new DshLoopbackError('upstream-unavailable', 'DSH 事件流尚未就绪，请稍后重试。')
    const outcome = response.ok === true
      ? { kind: 'result' as const, value: interaction.type === 'approval/requested'
        ? (typeof response.value?.outcome === 'string' ? response.value.outcome : undefined)
        : response.value?.answer }
      : {
        kind: 'rejected' as const,
        error: {
          name: typeof response.error?.name === 'string' ? response.error.name : 'Error',
          message: typeof response.error?.message === 'string' ? response.error.message : 'the client rejected the request',
          ...(typeof response.error?.code === 'string' ? { code: response.error.code } : {}),
          ...(response.error?.details === undefined ? {} : { details: response.error.details }),
        },
      }
    return this.#dsh.answerEvent({ clientId, eventId: interaction.rpcId, outcome })
  }

  #handleControlFrame(frame: DshControlFrame): void {
    if (frame.type === 'baseline') {
      const queues = frame.value?.queues ?? {}
      const jobs = frame.value?.jobs ?? {}
      this.#queues.clear()
      for (const [sessionId, items] of Object.entries(queues)) this.#queues.set(sessionId, items)
      this.#jobs.clear()
      for (const [sessionId, sessionJobs] of Object.entries(jobs)) this.#jobs.set(sessionId, sessionJobs)
      return
    }
    if (frame.type === 'queue') {
      const sessionId = frame.sessionId
      if (sessionId === undefined) return
      this.#queues.set(sessionId, frame.items ?? [])
      this.#broadcast({
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'session/queue',
        payload: { items: frame.items ?? [] },
        sessionId,
        snapshot: true,
      })
      return
    }
    if (frame.type === 'jobs') {
      const sessionId = frame.sessionId
      if (sessionId === undefined) return
      this.#jobs.set(sessionId, frame.jobs ?? [])
      this.#broadcast({
        contractVersion: 1,
        eventId: this.#nextStreamEventId(),
        type: 'session/jobs',
        payload: { jobs: frame.jobs ?? [] },
        sessionId,
        snapshot: true,
      })
      return
    }
    if (typeof frame.sessionId === 'string' && typeof frame.key === 'string') {
      const values = this.#projections.get(frame.sessionId) ?? {}
      this.#projections.set(frame.sessionId, { ...values, [frame.key]: frame.value })
    }
  }

  #handleWorkspaceFrame(frame: DshWorkspaceFrame): void {
    // The baseline and a replace both carry the whole admitted list under
    // `value`; reading `frame.items` left `#workspaces` empty, so the drawer had
    // no folders to group by and fell back to a flat list.
    if (frame.type === 'baseline' || frame.type === 'replace') {
      const value = frame.value
      const items = value?.items ?? []
      this.#workspaces = {
        items,
        archivedSessionIds: value?.archivedSessionIds ?? [],
      }
      const pinned = value?.pinnedSessionIds
      this.#pinnedSessionIds = Array.isArray(pinned) ? pinned : []
      return
    }
    if (frame.type === 'upsert') {
      const workspace = frame.workspace
      const workspaceId = workspace?.workspaceId
      if (workspace === undefined || workspaceId === undefined) return
      const others = (this.#workspaces.items ?? []).filter(item => item.workspaceId !== workspaceId)
      this.#workspaces = { ...this.#workspaces, items: [...others, workspace] }
      return
    }
    if (frame.type === 'remove') {
      const removed = frame.workspaceId
      if (removed === undefined) return
      this.#workspaces = {
        ...this.#workspaces,
        items: (this.#workspaces.items ?? []).filter(item => item.workspaceId !== removed),
      }
      return
    }
    if (frame.type === 'order') {
      const order = frame.workspaceIds ?? []
      const rank = new Map(order.map((id, index) => [id, index]))
      const items = [...(this.#workspaces.items ?? [])]
        .sort((a, b) => (rank.get(a.workspaceId) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.workspaceId) ?? Number.MAX_SAFE_INTEGER))
      this.#workspaces = { ...this.#workspaces, items }
    }
  }


  #createSessionSubscription(
    deviceId: string,
    sessionId: string,
    body: Record<string, unknown>,
  ): Record<string, unknown> {
    const lastSeenSeq = optionalNonnegativeInteger(body.lastSeenSeq, '上次事件水位线必须是非负整数。') ?? 0
    const client = this.#findEventClient(deviceId)
    if (client === undefined)
      throw new GatewayHttpError('bad-request', '建立会话订阅前必须先连接移动实时事件流。')
    const previous = client.subscriptions.get(sessionId)
    if (previous !== undefined) {
      this.#subscriptions.delete(previous.subscriptionId)
      this.#releaseFollowIfUnused(sessionId)
    }    const subscription: SessionSubscription = {
      subscriptionId: randomBytes(18).toString('base64url'),
      activationToken: randomBytes(32).toString('base64url'),
      deviceId,
      sessionId,
      cutoverEventId: this.#nextEventId,
      snapshotSeq: lastSeenSeq,
      state: 'hydrating',
      bufferedEvents: [],
      needsResync: false,
    }
    client.subscriptions.set(sessionId, subscription)
    this.#subscriptions.set(subscription.subscriptionId, subscription)
    this.#ensureFollow(sessionId)
    const status = [...this.#pending.values()].some(item => item.sessionId === sessionId) ? 'waiting' : 'idle'
    return {
      subscriptionId: subscription.subscriptionId,
      activationToken: subscription.activationToken,
      snapshotSeq: lastSeenSeq,
      cutoverEventId: subscription.cutoverEventId.toString(),
      snapshot: {
        items: [],
        status,
        interactions: [...this.#pending.values()].filter(item => item.sessionId === sessionId),
        queue: { items: this.#queues.get(sessionId) ?? [] },
        jobs: { items: this.#jobs.get(sessionId) ?? [] },
      },
    }
  }

  /** Opens the per-session DSH follow stream that feeds subscribed devices. */
  #ensureFollow(sessionId: string): void {
    if (this.#follows.has(sessionId)) return
    const controller = new AbortController()
    this.#follows.set(sessionId, { controller })
    void this.#captureFollow(sessionId, controller)
  }

  async #captureFollow(sessionId: string, controller: AbortController): Promise<void> {
    try {
      for await (const frame of this.#dsh.open(
        'session/follow',
        { request: { address: { kind: 'session', sessionId } } },
        controller.signal,
      )) {
        if (frame.type === 'snapshot') {
          const projections = (frame as DshFollowSnapshot).projections
          if (projections?.values !== undefined) this.#projections.set(sessionId, projections.values)
          continue
        }
        if (frame.type !== 'event' || frame.event === null || typeof frame.event !== 'object') continue
        const event = frame.event as Record<string, unknown>
        const seq = typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : undefined
        this.#broadcast({
          contractVersion: 1,
          eventId: this.#nextStreamEventId(),
          type: 'session/event',
          payload: { event },
          sessionId,
          ...(seq === undefined ? {} : { seq }),
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) console.error('[mobile-gateway] DSH session follow ended:', error)
    } finally {
      const follow = this.#follows.get(sessionId)
      if (follow !== undefined && follow.controller === controller) {
        this.#follows.delete(sessionId)
        const stillSubscribed = [...this.#subscriptions.values()].some(item => item.sessionId === sessionId)
        if (stillSubscribed && !controller.signal.aborted && this.#status !== undefined) {
          const retry = setTimeout(() => {
            this.#ensureFollow(sessionId)
          }, 1_000)
          retry.unref()
        }
      }
    }
  }

  #activateSessionSubscription(
    deviceId: string,
    subscriptionId: string,
    activationToken: string,
    appliedSnapshotSeq: number,
  ): { activated: true } {
    const subscription = this.#subscriptions.get(subscriptionId)
    if (subscription === undefined || subscription.deviceId !== deviceId)
      throw new GatewayHttpError('not-found', '会话订阅不存在或已失效。')
    if (!timingSafeEqual(Buffer.from(subscription.activationToken), Buffer.from(activationToken)))
      throw new GatewayHttpError('unauthorized', '会话订阅激活令牌无效。')
    if (subscription.snapshotSeq !== appliedSnapshotSeq)
      throw new GatewayHttpError('bad-request', '会话订阅快照水位线不匹配，请重新同步。')
    if (subscription.needsResync)
      throw new GatewayHttpError('upstream-unavailable', '实时事件缓冲已过期，请重新同步会话。')
    subscription.state = 'live'
    const client = this.#findEventClient(deviceId)
    if (client !== undefined) {
      for (const event of subscription.bufferedEvents)
        if (this.#shouldDeliverSubscriptionEvent(subscription, event)) this.#writeStreamEvent(client.response, event)
    }
    subscription.bufferedEvents.length = 0
    return { activated: true }
  }

  #findEventClient(deviceId: string): MobileEventClient | undefined {
    for (const client of this.#eventClients.values()) if (client.deviceId === deviceId) return client
    return undefined
  }

  #openEventStream(response: ServerResponse, deviceId: string): void {
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    })
    const client: MobileEventClient = { response, deviceId, subscriptions: new Map() }
    this.#eventClients.set(response, client)
    this.#startEventHeartbeat()
    this.#writeStreamEvent(response, {
      contractVersion: 1,
      eventId: this.#nextStreamEventId(),
      type: 'gateway/ready',
      payload: {},
      snapshot: true,
    })
    response.once('close', () => {
      this.#eventClients.delete(response)
      for (const subscription of client.subscriptions.values())
        if (this.#subscriptions.get(subscription.subscriptionId) === subscription)
          this.#subscriptions.delete(subscription.subscriptionId)
      for (const sessionId of new Set([...client.subscriptions.keys()])) this.#releaseFollowIfUnused(sessionId)
      if (this.#eventClients.size === 0) this.#stopEventHeartbeat()
    })
  }

  /** Aborts one session follow stream when no subscription still needs it. */
  #releaseFollowIfUnused(sessionId: string): void {
    const stillSubscribed = [...this.#subscriptions.values()].some(item => item.sessionId === sessionId)
    if (stillSubscribed) return
    const follow = this.#follows.get(sessionId)
    if (follow === undefined) return
    this.#follows.delete(sessionId)
    follow.controller.abort()
  }

  #broadcast(event: MobileStreamEvent): void {
    // Host-wide events (host/*) reach every connected device exactly like the
    // old desktop host channel; session-scoped events (approval and question
    // waterfalls, session/event, session/queue, session/jobs) only reach
    // devices subscribed to that session.
    const global = event.type.startsWith('host/')
    for (const client of this.#eventClients.values()) {
      if (global || event.sessionId === undefined) {
        this.#writeStreamEvent(client.response, event)
        continue
      }
      const subscription = client.subscriptions.get(event.sessionId)
      if (subscription === undefined) continue
      if (subscription.state === 'hydrating') {
        if (Number(event.eventId) > subscription.cutoverEventId) this.#bufferSubscriptionEvent(subscription, event)
        continue
      }
      if (this.#shouldDeliverSubscriptionEvent(subscription, event)) this.#writeStreamEvent(client.response, event)
    }
  }

  #bufferSubscriptionEvent(subscription: SessionSubscription, event: MobileStreamEvent): void {
    if (subscription.bufferedEvents.length >= MAX_SUBSCRIPTION_BUFFER_EVENTS) {
      subscription.needsResync = true
      subscription.bufferedEvents.length = 0
      return
    }
    subscription.bufferedEvents.push(event)
  }

  #shouldDeliverSubscriptionEvent(subscription: SessionSubscription, event: MobileStreamEvent): boolean {
    if (event.sessionId !== subscription.sessionId) return false
    if (event.seq !== undefined) return event.seq > subscription.snapshotSeq
    return Number(event.eventId) > subscription.cutoverEventId
  }

  #nextStreamEventId(): string {
    this.#nextEventId += 1
    return this.#nextEventId.toString()
  }

  #startEventHeartbeat(): void {
    if (this.#eventHeartbeat !== undefined) return
    const heartbeat = setInterval(() => {
      for (const client of this.#eventClients.values()) client.response.write(': heartbeat\n\n')
    }, 2_500)
    heartbeat.unref()
    this.#eventHeartbeat = heartbeat
  }

  #stopEventHeartbeat(): void {
    if (this.#eventHeartbeat === undefined) return
    clearInterval(this.#eventHeartbeat)
    this.#eventHeartbeat = undefined
  }

  #writeStreamEvent(response: ServerResponse, event: MobileStreamEvent): void {
    response.write(`id: ${event.eventId}\nevent: message\ndata: ${JSON.stringify(event)}\n\n`)
  }

  #prunePairings(): void {
    const now = Date.now()
    for (const [pairingId, pairing] of this.#pairings) {
      if (pairing.expiresAt <= now) this.#pairings.delete(pairingId)
    }
  }

  // Every caller awaits this wrapper, and typescript/await-thenable rejects returning the value bare.
  // oxlint-disable-next-line typescript/require-await
  async #response<T>(data: T): Promise<MobileResponse<T>> {
    return { contractVersion: 1, dshUrl: this.#status?.url ?? '', data }
  }
}

class GatewayHttpError extends Error {
  readonly code: MobileGatewayError['code']

  constructor(code: MobileGatewayError['code'], message: string) {
    super(message)
    this.code = code
  }
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request as AsyncIterable<unknown>) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array)
    total += buffer.byteLength
    if (total > MAX_BODY_BYTES) throw new GatewayHttpError('bad-request', '请求体过大。')
    chunks.push(buffer)
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') throw new Error('not an object')
    return parsed as Record<string, unknown>
  } catch {
    throw new GatewayHttpError('bad-request', '请求体必须是 JSON 对象。')
  }
}

function pairingSecretHash(value: string): Uint8Array {
  return createHash('sha256').update(value).digest()
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

function writeError(response: ServerResponse, error: MobileGatewayError): void {
  const status =
    error.code === 'unauthorized'
      ? 401
      : error.code === 'not-found' || error.code === 'session-not-found' || error.code === 'pairing-not-found'
        ? 404
        : error.code === 'settings-conflict'
          ? 409
          : error.code === 'bad-request' || error.code === 'forbidden' || error.code === 'agent-preset-locked'
            ? 400
            : 502
  writeJson(response, status, { error })
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new GatewayHttpError('bad-request', message)
  return value.trim()
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined) return undefined
  return requireText(value, '设置字段必须是非空字符串。')
}

function requireObject(value: unknown, message: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new GatewayHttpError('bad-request', message)
  return value as Record<string, unknown>
}

function requireArray(value: unknown, message: string): unknown[] {
  if (!Array.isArray(value)) throw new GatewayHttpError('bad-request', message)
  return value
}

type GatewayPromptContent =
  | { type: 'text'; text: string }
  | { type: 'image'; mediaType: string; data: string; name?: string }

function readPromptContent(body: Record<string, unknown>): GatewayPromptContent[] {
  // Keep the old text body shape for an already-paired app that has not yet
  // updated, while all current native clients use the content-array contract.
  const parts = body.content === undefined ? [{ type: 'text', text: body.text }] : requireArray(body.content, '消息内容必须是数组。')
  if (parts.length === 0 || parts.length > MAX_PROMPT_IMAGES + 1)
    throw new GatewayHttpError('bad-request', `消息最多包含一段文本和 ${MAX_PROMPT_IMAGES} 张图片。`)

  let imageCount = 0
  let textCount = 0
  return parts.map((part, index) => {
    const item = requireObject(part, `第 ${index + 1} 项消息内容无效。`)
    if (item.type === 'text') {
      const text = requireText(item.text, '消息文本不能为空。')
      if (text.length > MAX_PROMPT_TEXT_CHARS)
        throw new GatewayHttpError('bad-request', `消息文本不得超过 ${MAX_PROMPT_TEXT_CHARS} 个字符。`)
      textCount += 1
      if (textCount > 1) throw new GatewayHttpError('bad-request', '一条消息只能包含一段文本。')
      return { type: 'text', text }
    }
    if (item.type === 'image') {
      const mediaType = requireText(item.mediaType, '图片类型不能为空。')
      const data = requireText(item.data, '图片数据不能为空。')
      if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new GatewayHttpError('bad-request', '图片格式必须为 GIF、JPEG、PNG 或 WebP。')
      if (data.length > MAX_IMAGE_BASE64_CHARS || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
        throw new GatewayHttpError('bad-request', '图片数据无效或过大。')
      imageCount += 1
      if (imageCount > MAX_PROMPT_IMAGES) throw new GatewayHttpError('bad-request', `一条消息最多包含 ${MAX_PROMPT_IMAGES} 张图片。`)
      const name = item.name === undefined ? undefined : requireText(item.name, '图片文件名不能为空。')
      if (name !== undefined && name.length > 255) throw new GatewayHttpError('bad-request', '图片文件名过长。')
      return { type: 'image', mediaType, data, ...(name === undefined ? {} : { name }) }
    }
    throw new GatewayHttpError('bad-request', '消息内容类型仅支持文本或图片。')
  })
}

function optionalNonnegativeInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) throw new GatewayHttpError('bad-request', message)
  return value
}
function optionalPositiveInteger(value: unknown, message: string): number | undefined {
  if (value === undefined) return undefined
  return requirePositiveInteger(value, message)
}

function requirePositiveInteger(value: unknown, message: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) throw new GatewayHttpError('bad-request', message)
  return value
}
function optionalRevision(value: unknown): number | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
    throw new GatewayHttpError('bad-request', '设置版本号必须是非负整数。')
  return value
}
function toMobileHistoryItems(records: readonly DshHistoryRecord[]): MobileHistoryItem[] {
  return records.flatMap((entry) => {
    const event = entry.event
    if (event === undefined) return []
    const seq = typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : undefined
    return [{ ...(seq === undefined ? {} : { seq }), event }]
  })
}

function decodePathSegment(match: RegExpMatchArray): string {
  return decodePathSegmentAt(match, 1, '会话路径无效。')
}

function decodePathSegmentAt(match: RegExpMatchArray, index: number, message: string): string {
  const segment = match[index]
  if (segment === undefined || segment === '') throw new GatewayHttpError('bad-request', message)
  return decodeURIComponent(segment)
}

function requireGoalRef(value: unknown): { id: string; revision: number } {
  const ref = requireObject(value, '目标版本信息无效。')
  return {
    id: requireText(ref.id, '目标标识不能为空。'),
    revision: requirePositiveInteger(ref.revision, '目标版本必须是正整数。'),
  }
}

function requireSubagentMode(value: unknown): 'one-shot' | 'continuable' {
  if (value === 'one-shot' || value === 'continuable') return value
  throw new GatewayHttpError('bad-request', '子 Agent 模式无效。')
}

function isExpectedInteractionResponse(interaction: PendingInteraction, result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const response = result as Record<string, unknown>
  if (interaction.type === 'question/requested' && isPlanReviewRequest(interaction.payload.questions) && isPlanReviewCancellation(response))
    return true
  if (
    response.ok !== true ||
    response.value === null ||
    typeof response.value !== 'object' ||
    Array.isArray(response.value)
  )
    return false
  const value = response.value as Record<string, unknown>
  if (interaction.type === 'approval/requested') {
    return (
      value.sessionId === interaction.sessionId &&
      value.approvalId === interaction.payload.approvalId &&
      (value.outcome === 'allowed-once' || value.outcome === 'rejected')
    )
  }
  if (
    value.sessionId !== interaction.sessionId ||
    value.answer === null ||
    typeof value.answer !== 'object' ||
    Array.isArray(value.answer)
  )
    return false
  const answers = (value.answer as Record<string, unknown>).answers
  if (!Array.isArray(answers) || answers.length !== (interaction.payload.questions as unknown[]).length) return false
  const expectedIds = new Set(
    (interaction.payload.questions as Array<{ id?: unknown }>)
      .map(question => question.id)
      .filter((id): id is string => typeof id === 'string'),
  )
  return (
    expectedIds.size === answers.length &&
    answers.every((answer) => {
      if (answer === null || typeof answer !== 'object' || Array.isArray(answer)) return false
      const item = answer as Record<string, unknown>
      return (
        typeof item.id === 'string' &&
        expectedIds.delete(item.id) &&
        Array.isArray(item.selected) &&
        item.selected.every(selected => typeof selected === 'string') &&
        (item.custom === undefined || typeof item.custom === 'string')
      )
    })
  )
}

function isPlanReviewRequest(questions: unknown): boolean {
  if (!Array.isArray(questions) || questions.length !== 1) return false
  const question = questions[0] as unknown
  if (question === null || typeof question !== 'object' || Array.isArray(question)) return false
  const value = question as Record<string, unknown>
  if (value.detail === undefined || value.multiSelect === true) return false
  const intent = value.intent
  if (intent === null || typeof intent !== 'object' || Array.isArray(intent)) return false
  const approve = (intent as Record<string, unknown>).approve
  if ((intent as Record<string, unknown>).kind !== 'plan-review' || typeof approve !== 'string') return false
  const options = value.options
  if (!Array.isArray(options) || options.length > 2) return false
  return options.some(option => option !== null && typeof option === 'object' && (option as Record<string, unknown>).label === approve)
}

function isPlanReviewCancellation(response: Record<string, unknown>): boolean {
  if (response.ok !== false || response.error === null || typeof response.error !== 'object' || Array.isArray(response.error)) return false
  const error = response.error as Record<string, unknown>
  return error.code === 'cancelled' && typeof error.message === 'string' && error.details !== null && typeof error.details === 'object'
}

function inferSessionStatus(items: Array<{ event?: Record<string, unknown> }>): 'running' | 'waiting' | 'idle' {
  const openTurns = new Set<number>()
  for (const item of items) {
    const event = item.event
    if (event === undefined) continue
    if (event.type === 'approval/requested' || event.type === 'question/requested') return 'waiting'
    const data = event.data !== null && typeof event.data === 'object' && !Array.isArray(event.data)
      ? event.data as Record<string, unknown>
      : event
    const turn = typeof data.turn === 'number' && Number.isInteger(data.turn) ? data.turn : undefined
    if (turn === undefined) continue
    if (event.type === 'turn/start') openTurns.add(turn)
    else if (event.type === 'turn/end' || event.type === 'turn/error') openTurns.delete(turn)
  }
  return openTurns.size > 0 ? 'running' : 'idle'
}

function toGatewayError(error: unknown): MobileGatewayError {
  if (error instanceof GatewayHttpError) return { code: error.code, message: error.message }
  if (error instanceof DshLoopbackError) {
    if (error.code === 'upstream-rejected') return upstreamRejectedError(error.upstreamCode)
    return { code: error.code, message: upstreamMessage(error.code) }
  }
  return { code: 'upstream-unavailable', message: upstreamMessage('upstream-unavailable') }
}

function upstreamRejectedError(code: string | undefined): MobileGatewayError {
  switch (code) {
    case 'session-not-found':
      return { code, message: '未找到请求的会话。' }
    case 'model-unavailable':
      return { code, message: '所选模型当前不可用，请重新选择。' }
    case 'agent-preset-locked':
      return { code, message: '会话已经开始，无法切换 Agent 模式。' }
    case 'agent-preset-not-found':
      return { code, message: '未找到所选 Agent 预设。' }
    case 'agent-preset-invalid':
      return { code, message: '所选 Agent 预设当前不可用。' }
    case 'settings-rejected':
      return { code, message: '设置未被桌面端接受，请检查输入。' }
    case 'settings-conflict':
      return { code, message: '设置已被其他窗口修改，请重新加载后再试。' }
    default:
      return { code: 'upstream-rejected', message: upstreamMessage('upstream-rejected') }
  }
}

function upstreamMessage(code: DshLoopbackError['code']): string {
  return code === 'upstream-rejected' ? '桌面端拒绝了此次请求。' : '桌面端 DeepSeek Harness 当前不可用。'
}

/** Selects the workspace fields required by the mobile drawer's project and session tree. */
function mobileWorkspaces(
  items: readonly DshWorkspace[] | undefined,
): Array<{ workspaceId: string; title: string; path?: string; sessionIds: string[] }> {
  return (items ?? []).map(workspace => ({
    workspaceId: workspace.workspaceId,
    title: workspace.title ?? '',
    ...(workspace.path === undefined ? {} : { path: workspace.path }),
    sessionIds: workspace.sessionIds ?? [],
  }))
}

/** Applies projection hints (durable title, blank state) onto one list row. */
function withVisibleSessionMetadata(item: DshSessionSummary, cached: Record<string, unknown> | undefined): DshSessionSummary {
  const values = item.projections?.values ?? cached ?? {}
  const projectedTitle = typeof values.title === 'string' && values.title.trim() !== '' ? values.title : undefined
  const metadata = values.sessionListMetadata
  const blank = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>).blank
    : item.blank
  return {
    ...item,
    ...(projectedTitle === undefined ? {} : { title: projectedTitle }),
    ...(typeof blank === 'boolean' ? { blank } : {}),
  }
}
