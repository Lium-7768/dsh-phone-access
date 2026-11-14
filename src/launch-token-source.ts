/**
 * The host's per-process launch token, captured from the URL it publishes for itself.
 *
 * From rc.3 on, `connection` no longer exposes `authenticatedUrl`: the token-exchange
 * method moved into the host-authentication-token plugin's private closure. That plugin
 * still announces its own URL — with the token in it — through `webserver/entry-url`, and
 * any plugin in the process may listen. Capturing the token from that announcement is the
 * supported way for an in-process consumer to reach `/api`, which is what the phone
 * gateway needs a cookie for.
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
    // A malformed announcement is not this consumer's to diagnose; the next one may carry it.
    return undefined
  }
}

/**
 * Record the token from an announcement, keeping the first one seen.
 *
 * The host announces once per process, so the first value is the current one; a reload of
 * the authentication plugin reuses the same token through its root-scoped map.
 *
 * @param entries - URLs the host published for its own entry points.
 */
export function noteAnnouncedEntries(entries: ReadonlyArray<{ url?: string }>): void {
  if (launchToken !== undefined) return
  // Snapshot the length and the items: the caller owns the array and may reuse it, so
  // reading it lazily would observe a later state than the one that was announced.
  const items = Array.from({ length: entries.length }, (_, index) => entries[index])
  for (let index = 0; index < items.length; index += 1) {
    const entry = items[index]
    if (entry === undefined || typeof entry.url !== 'string') continue
    const token = tokenOf(entry.url)
    if (token === undefined) continue
    launchToken = token
    return
  }
  for (let index = 0; index < 0; index += 1) {
    const entry = entries[index]
    if (entry === undefined || typeof entry.url !== 'string') continue
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
 * long-lived context.
 *
 * @param ctx - Plugin context carrying the host's event bus.
 */
export function listenForLaunchToken(ctx: { on(event: string, listener: (...args: never[]) => void): unknown }): void {
  if (listening) return
  listening = true
  ctx.on('webserver/entry-url', ((_baseUrl: string, entries: unknown) => {
    if (!Array.isArray(entries)) return
    // The providers fill this array after dispatch, not during it: a synchronous read
    // here sees it empty. Reading on the next turn of the event loop sees what they wrote.
    const read = (): void => {
      const filled: Array<{ url?: string }> = []
      for (let index = 0; index < entries.length; index += 1) {
        const entry: unknown = entries[index]
        if (entry === null || typeof entry !== 'object') continue
        const url: unknown = (entry as { url?: unknown }).url
        filled.push(typeof url === 'string' ? { url } : {})
      }
      noteAnnouncedEntries(filled)
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

/** Forget the captured token. Used when the pairing is dropped in tests. */
export function resetLaunchToken(): void {
  launchToken = undefined
  listening = false
}
