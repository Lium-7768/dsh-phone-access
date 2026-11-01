import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

interface RpcFailure {
  ok: false
  error: { code: string; message: string; details: unknown }
}

interface RpcSuccess<T> {
  ok: true
  value: T
}

interface RpcResponse<T> {
  type: 'server-response'
  rpcId: string
  result: RpcSuccess<T> | RpcFailure
}

/**
 * The gateway WebSocket multiplexer path and Remote stream envelope contract
 * served by the DSH api gateway (`@deepseek-ai/dsh-api-gateway`
 * stream-protocol). Fixed wire facts of the runtime, not configuration.
 */
const REMOTE_STREAM_MUX_PATH = '/api/remote.mux'


const REMOTE_EVENT_ENDPOINT = '$events'
const REMOTE_EVENT_RESULT_ENDPOINT = '$events/result'

type StreamServerMessage =
  | { readonly type: 'item'; readonly streamId: string; readonly value?: unknown }
  | { readonly type: 'error'; readonly streamId: string; readonly error: { code?: string; message: string } }
  | { readonly type: 'end'; readonly streamId: string }

/** Calls the current DSH web runtime only through its loopback listener. */
export class DshLoopbackClient {
  readonly #baseUrl: URL

  /** @param baseUrl - The loopback URL owned by the desktop DSH runtime. */
  /** Browser cookie that satisfies the current release's peer fence. */
  #cookie: string | undefined
  /**
   * Mints a fresh cookie for one stream.
   *
   * A peer owns at most one socket, and the host drops the peer when that socket
   * ends, so two streams must not share a credential.
   */
  #cookieProvider: (() => Promise<string | undefined>) | undefined

  /**
   * @param baseUrl - Loopback origin of the running host.
   * @param cookie - Cookie minted from the host's launch token, when one is available.
   */
  constructor(baseUrl: string, cookie?: string, cookieProvider?: () => Promise<string | undefined>) {
    this.#cookie = cookie
    this.#cookieProvider = cookieProvider
    const parsed = new URL(baseUrl)
    if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
      throw new Error('The Mobile Gateway only accepts a loopback DSH URL.')
    }
    this.#baseUrl = parsed
  }

  /**
   * Invokes one allowlisted DSH Remote endpoint and returns its business value.
   * @param endpoint - `namespace/method` endpoint forwarded by the api gateway.
   * @param args - Wire args keyed by the endpoint's parameter names.
   * @returns The accepted DSH business value.
   * @throws {DshLoopbackError} When DSH is unavailable, returns malformed data, or rejects the RPC.
   */
  async call<T>(endpoint: string, args: Record<string, unknown>): Promise<T> {
    const rpcId = randomUUID()
    // The Remote route carries the endpoint in the path, and the descriptor
    // expects its declared arguments under `_request`.
    const response = await fetch(new URL(`/api/${endpoint}`, this.#baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: this.#baseUrl.host,
        ...(this.#cookie === undefined ? {} : { cookie: this.#cookie }),
      },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args } }),
    })
    if (!response.ok) throw new DshLoopbackError('upstream-unavailable', `DSH returned HTTP ${response.status}.`)
    const message = (await response.json()) as RpcResponse<T>
    if (message.rpcId !== rpcId) {
      throw new DshLoopbackError('upstream-unavailable', 'DSH returned an invalid RPC response.')
    }
    if (!message.result.ok) {
      throw new DshLoopbackError(
        'upstream-rejected',
        message.result.error.message,
        message.result.error.code,
        message.result.error.details,
      )
    }
    return message.result.value
  }

  /**
   * Answers one pending Host Remote event delivery through the gateway's
   * forwarded-event result endpoint.
   * @param result - Client event result carrying the opening `clientId`.
   * @returns The gateway's acceptance value.
   * @throws {DshLoopbackError} When DSH is unavailable or rejects the result.
   */
  async answerEvent<T = unknown>(result: Record<string, unknown>): Promise<T> {
    return this.call<T>(REMOTE_EVENT_RESULT_ENDPOINT, result)
  }

  /**
   * Opens the gateway-internal forwarded Host event stream.
   * @param signal - Abort signal that cancels the stream.
   * @returns Remote event frames: `ready`, then `emit`, `waterfall`, and `cancel`.
   */
  openEvents(signal: AbortSignal): AsyncGenerator<Record<string, unknown>> {
    return this.open(REMOTE_EVENT_ENDPOINT, {}, signal)
  }

  /**
   * Opens one logical Remote stream on the runtime WebSocket multiplexer.
   * @param endpoint - Stream endpoint such as `session/control` or `workspace/follow`.
   * @param args - Wire args keyed by the endpoint's parameter names.
   * @param signal - Abort signal that cancels the logical stream.
   * @returns Stream item values until the Host ends or fails the stream.
   */
  async *open(
    endpoint: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): AsyncGenerator<Record<string, unknown>> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
    const url = new URL(REMOTE_STREAM_MUX_PATH, this.#baseUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const streamCookie = this.#cookieProvider === undefined ? this.#cookie : await this.#cookieProvider()
    const socket = new WebSocket(url, { headers: { host: this.#baseUrl.host, ...(streamCookie === undefined ? {} : { cookie: streamCookie }) } })
    const inbox: StreamItem[] = []
    let wake: (() => void) | undefined
    let settled = false
    const enqueue = (item: StreamItem): void => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const opened = new Promise<void>((resolve, reject) => {
      socket.once('open', resolve)
      socket.once('error', reject)
    })
    const streamId = randomUUID()
    const handleMessage = (data: WebSocket.RawData): void => {
      const text = Array.isArray(data)
        ? Buffer.concat(data).toString()
        : data instanceof ArrayBuffer
          ? new TextDecoder().decode(data)
          : data.toString()
      const message = parseStreamServerMessage(text, streamId)
      if (message === undefined) return
      if (message.type === 'item') enqueue({ kind: 'item', value: message.value })
      else if (message.type === 'error') enqueue({ kind: 'error', error: message.error })
      else enqueue({ kind: 'end' })
    }
    const handleClose = (): void => {
      if (!settled) enqueue({ kind: 'closed' })
    }
    const handleAbort = (): void => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
        if (!settled) socket.send(JSON.stringify({ type: 'cancel', streamId }))
        socket.close()
      }
    }
    try {
      await opened
      socket.on('message', handleMessage)
      socket.once('close', handleClose)
      signal.addEventListener('abort', handleAbort, { once: true })
      // An abort may already have fired between construction and this registration.
      // oxlint-disable-next-line typescript/no-unnecessary-condition
      if (signal.aborted) handleAbort()
      socket.send(JSON.stringify({ type: 'open', streamId, endpoint, payload: { args } }))
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift() as StreamItem
          if (item.kind === 'item') yield (item.value ?? {}) as Record<string, unknown>
          else if (item.kind === 'error') {
            throw new DshLoopbackError(
              'upstream-rejected',
              item.error.message,
              typeof item.error.code === 'string' ? item.error.code : undefined,
            )
          } else return
        }
        await new Promise<void>((resolve) => { wake = resolve })
      }
    } finally {
      settled = true
      signal.removeEventListener('abort', handleAbort)
      socket.off('message', handleMessage)
      socket.off('close', handleClose)
      handleAbort()
    }
  }
}

type StreamItem =
  | { kind: 'item'; value?: unknown }
  | { kind: 'error'; error: { code?: string; message: string } }
  | { kind: 'end' }
  | { kind: 'closed' }

function parseStreamServerMessage(text: string, streamId: string): StreamServerMessage | undefined {
  try {
    const value: unknown = JSON.parse(text)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (record.streamId !== streamId) return undefined
    if (record.type === 'item' || record.type === 'error' || record.type === 'end') {
      return record as unknown as StreamServerMessage
    }
    return undefined
  } catch {
    return undefined
  }
}

/** An upstream DSH fault translated to a Mobile Gateway-safe error. */
export class DshLoopbackError extends Error {
  /** Mobile-safe category distinguishing transport availability from DSH rejection. */
  readonly code: 'upstream-unavailable' | 'upstream-rejected'
  /** DSH business error code when the upstream RPC rejected the request. */
  readonly upstreamCode: string | undefined
  /** DSH business error details when the upstream RPC rejected the request. */
  readonly details: unknown

  /**
   * @param code - Mobile transport category.
   * @param message - Upstream message retained for diagnostics.
   * @param upstreamCode - DSH business error code, when the RPC was rejected.
   * @param details - DSH business error details, when the RPC was rejected.
   */
  constructor(code: DshLoopbackError['code'], message: string, upstreamCode?: string, details?: unknown) {
    super(message)
    this.code = code
    this.upstreamCode = upstreamCode
    this.details = details
  }
}
