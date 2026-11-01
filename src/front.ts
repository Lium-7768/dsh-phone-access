/**
 * The listener the phone reaches: it answers the password sign-in itself and
 * forwards every other request to the loopback gateway.
 *
 * Keeping the gateway on loopback and proxying here means the upstream package
 * keeps its own security assumption, and the one route it does not implement
 * lives in this project instead of a patched copy.
 */
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { MobileDeviceRegistry } from './gateway/device-registry.ts'
import { AuthRateLimit, type PasswordStore } from './password.ts'

/** Options for {@link startFront}. */
export interface FrontOptions {
  /** Loopback origin of the DSH host and its gateway listener. */
  gatewayUrl: string
  /** Device registry that issues the credential. */
  devices: MobileDeviceRegistry
  /** Password the sign-in accepts. */
  password: PasswordStore
  /** Port to listen on; `0` picks a free one. */
  port: number
  /** Host to listen on; the tunnel reaches it over loopback. */
  host: string
  /** Reports a sign-in and rotation so the caller can log it. */
  log: (message: string) => void
}

/** A running front listener. */
export interface FrontHandle {
  /** Port actually bound. */
  port: number
  /** Stop the listener. */
  close: () => Promise<void>
}

/** Headers that describe one connection and must not be forwarded. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization'])

/**
 * Start the front listener.
 *
 * @param options - Gateway address, credential source, and listener bounds.
 * @returns The bound port and a disposer.
 */
export async function startFront(options: FrontOptions): Promise<FrontHandle> {
  const limit = new AuthRateLimit()
  const server = createServer((request, response) => {
    void handle(options, limit, request, response)
  })
  // Agent sessions stream over SSE; disable the default request timeout so a long
  // turn is not cut off mid-stream.
  server.requestTimeout = 0
  server.headersTimeout = 30_000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, options.host, () => resolve())
  })
  const address = server.address() as AddressInfo
  return {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

/**
 * Route one request.
 *
 * @param options - Front configuration.
 * @param limit - Failure tracker.
 * @param request - Incoming request.
 * @param response - Response to write.
 */
async function handle(
  options: FrontOptions,
  limit: AuthRateLimit,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const path = new URL(request.url ?? '/', 'http://front.invalid').pathname
  if (path === '/v1/auth' && request.method === 'POST') {
    await handleAuth(options, limit, request, response)
    return
  }
  forward(options, request, response)
}




/**
 * Answer one password sign-in.
 *
 * @param options - Front configuration.
 * @param limit - Failure tracker.
 * @param request - Incoming request.
 * @param response - Response to write.
 */
async function handleAuth(
  options: FrontOptions,
  limit: AuthRateLimit,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const client = clientKey(request)
  if (limit.blocked(client)) {
    writeJson(response, 429, { contractVersion: 1, error: { code: 'rate-limited', message: '尝试过于频繁，请稍后再试。' } })
    return
  }
  let body: unknown
  try {
    body = JSON.parse(await readBody(request))
  } catch {
    writeJson(response, 400, { contractVersion: 1, error: { code: 'invalid-request', message: '请求格式无效。' } })
    return
  }
  const candidate = typeof (body as { password?: unknown }).password === 'string'
    ? (body as { password: string }).password
    : ''
  if (!options.password.matches(candidate)) {
    limit.fail(client)
    writeJson(response, 401, { contractVersion: 1, error: { code: 'credentials', message: '访问密码不正确。' } })
    return
  }
  limit.succeed(client)
  const credential = options.devices.create(deviceLabel(request))
  options.log(`issued a device credential for ${deviceLabel(request)}`)
  writeJson(response, 200, { contractVersion: 1, data: credential })
}

/**
 * Forward one request to the gateway and stream the answer back.
 *
 * @param options - Front configuration.
 * @param request - Incoming request.
 * @param response - Response to write.
 */
function forward(options: FrontOptions, request: IncomingMessage, response: ServerResponse): void {
  const target = new URL(request.url ?? '/', options.gatewayUrl)
  const headers: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    headers[name] = value
  }
  const upstream = httpRequest(
    { hostname: target.hostname, port: target.port, path: `${target.pathname}${target.search}`, method: request.method, headers },
    (upstreamResponse) => {
      const outHeaders: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
        outHeaders[name] = value
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, outHeaders)
      upstreamResponse.pipe(response)
    },
  )
  upstream.on('error', () => {
    if (!response.headersSent) writeJson(response, 502, { contractVersion: 1, error: { code: 'upstream', message: '桌面端运行时暂不可用。' } })
    else response.end()
  })
  request.pipe(upstream)
}

/**
 * Read a request body with a bound, so a large payload cannot exhaust memory.
 *
 * @param request - Incoming request.
 * @returns The body as text.
 */
function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    request.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 64 * 1024) {
        reject(new Error('body too large'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/**
 * Identify a client for the rate limit.
 *
 * Behind the tunnel every request arrives from the tunnel client, so the
 * forwarded address header is preferred and the socket address is the fallback.
 *
 * @param request - Incoming request.
 * @returns A stable client key.
 */
function clientKey(request: IncomingMessage): string {
  const peer = request.socket.remoteAddress ?? 'unknown'
  // The forwarding headers are only believable when the peer is the tunnel, which
  // dials loopback. A LAN peer can send `x-forwarded-for: <anything>`, so trusting
  // them there would let one host answer as thousands and defeat the per-client
  // limit that keeps a password guesser out.
  const fromTunnel = peer === '127.0.0.1' || peer === '::1' || peer === '::ffff:127.0.0.1'
  if (!fromTunnel) return peer
  const forwarded = request.headers['cf-connecting-ip'] ?? request.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded !== '') return forwarded.split(',')[0]!.trim()
  if (Array.isArray(forwarded) && forwarded[0] !== undefined) return forwarded[0].split(',')[0]!.trim()
  return peer
}

/**
 * Name a device from the request that created it.
 *
 * @param request - Incoming request.
 * @returns A label the desktop settings can show.
 */
function deviceLabel(request: IncomingMessage): string {
  const agent = request.headers['user-agent']
  const platform = typeof agent === 'string' && agent.includes('iPhone') ? 'iPhone' : '手机'
  return platform
}

/**
 * Write one JSON response.
 *
 * @param response - Response to write.
 * @param status - HTTP status.
 * @param payload - Body to serialise.
 */
function writeJson(response: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(body)
}

export type { Server }
