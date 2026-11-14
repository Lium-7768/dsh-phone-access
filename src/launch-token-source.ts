/**
 * The host's per-process launch token, captured from the URL it publishes for itself.
 *
 * From rc.3 on, `connection` no longer exposes `authenticatedUrl`: the token-exchange
 * method moved into the host-authentication-token plugin's private closure. That plugin
 * still announces its own URL — with the token in it — through `webserver/entry-url`, and
 * any plugin in the process may listen. Capturing the token from that announcement is the
 * supported way for an in-process consumer to reach `/api`, which is what the phone
 * gateway needs a cookie for.
 *
 * The announcement is not readable during dispatch: the host emits the event with an
 * empty list, and its providers append their entries a turn of the event loop later. A
 * listener that reads the list synchronously therefore always sees nothing.
 */

/** Query parameter the host writes its launch token into. */
const TOKEN_QUERY = 'token'

let launchToken: string | undefined
let listening = false

/**
 * Extract the token from one announced entry URL.
 *
 * @param url - The announced URL, absolute and carrying the token when the host set one.
 * @returns The token, or undefined when this URL carries none.
 */
function tokenOf(url: string): string | undefined {
  try {
    const value = new URL(url).searchParams.get(TOKEN_QUERY)
    return value === null || value === '' ? undefined : value
  } catch {
    // A malformed announcement is not this consumer's to diagnose; a later one may carry it.
    return undefined
  }
}

/**
 * Record the token from an announcement, keeping the first one seen.
 *
 * The host announces once per process, so the first value is the current one; reloading
 * the authentication plugin reuses the same token through its root-scoped map.
 *
 * @param entries - Entry URLs the host published for itself.
 */
function noteAnnouncedEntries(entries: ReadonlyArray<{ url?: string }>): void {
  if (launchToken !== undefined) return
  for (const entry of entries) {
    if (typeof entry.url !== 'string') continue
    const token = tokenOf(entry.url)
    if (token === undefined) continue
    launchToken = token
    return
  }
}

/**
 * The launch token this process published, if it has been announced yet.
 *
 * @returns The token, or undefined before the host announces its entry URLs.
 */
export function currentLaunchToken(): string | undefined {
  return launchToken
}

/**
 * Subscribe to the host's entry-URL announcements.
 *
 * Subscribing is idempotent because a plugin reload would otherwise stack listeners on a
 * context that outlives the reload.
 *
 * @param ctx - Plugin context carrying the host's event bus.
 */
export function listenForLaunchToken(ctx: { on(event: string, listener: (...args: never[]) => void): unknown }): void {
  if (listening) return
  listening = true
  ctx.on('webserver/entry-url', ((_baseUrl: string, announced: unknown) => {
    if (!Array.isArray(announced)) return
    // Read after dispatch, not during it. The microtask covers providers that appended
    // synchronously, the timer covers one that deferred, and both are cheap no-ops once a
    // token is recorded.
    const read = (): void => {
      const entries: Array<{ url?: string }> = []
      for (const value of announced as unknown[]) {
        if (value === null || typeof value !== 'object') continue
        const url: unknown = (value as { url?: unknown }).url
        entries.push(typeof url === 'string' ? { url } : {})
      }
      noteAnnouncedEntries(entries)
    }
    queueMicrotask(read)
    setTimeout(read, 10)
  }) as (...args: never[]) => void)
}

/**
 * Build the URL carrying the launch token, for the cookie exchange.
 *
 * @param baseUrl - The host origin, without a path.
 * @returns The authenticated URL.
 * @throws {Error} When the host has not announced its token yet.
 */
export function authenticatedUrl(baseUrl: string): string {
  if (launchToken === undefined)
    throw new Error('the host has not announced its launch token yet; it is published once per process')
  const url = new URL(baseUrl)
  url.searchParams.set(TOKEN_QUERY, launchToken)
  return url.href
}
