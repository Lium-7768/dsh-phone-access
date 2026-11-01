/**
 * Exchange the host launch token for the cookie the Remote route accepts.
 *
 * The token is generated per host process and never written down, so only code
 * inside that process can ask the connection service for it. The cookie it buys
 * is what admits `/api` and the stream multiplexer in the current release.
 */

/**
 * Exchange a launch-token URL for the cookie header value.
 *
 * The request must not follow the redirect: the token exchange answers with a
 * `302` and the cookie on that response. Following it would land on the app shell
 * and lose the header.
 *
 * @param authenticatedUrl - Origin carrying the launch token as a query parameter.
 * @returns The cookie header value, or `undefined` when the host set none.
 */
export async function exchangeLaunchToken(authenticatedUrl: string): Promise<string | undefined> {
  // The root exchange mints a browser cookie (version 1), which the Remote route
  // refuses: it admits only a non-page peer cookie. `/connect` mints that one, and
  // The forwarded-event stream ($events) is refused to a peer minted with
  // `interactions=none`, and that stream is what the phone's live updates ride on,
  // so this caller declares `answer`.
  const tokenUrl = new URL(authenticatedUrl)
  const connectUrl = new URL('/connect', tokenUrl.origin)
  connectUrl.searchParams.set('token', tokenUrl.searchParams.get('token') ?? '')
  connectUrl.searchParams.set('interactions', 'answer')
  const response = await fetch(connectUrl, { redirect: 'manual' })
  const setCookies = response.headers.getSetCookie?.() ?? []
  const pairs = setCookies
    .map(value => value.split(';')[0]?.trim())
    .filter((value): value is string => value !== undefined && value !== '')
  return pairs.length === 0 ? undefined : pairs.join('; ')
}
