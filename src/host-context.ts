/**
 * The Host services and Cordis mixins this plugin reaches through its context.
 *
 * DeepSeek Harness declares the services through declaration merging in packages
 * the bridge does not depend on; the same two members are declared here, narrowed
 * to what the bridge calls. The `inject` mixin mirrors what Cordis installs on the
 * runtime proxy, which the declared class does not carry.
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Fiber, Inject, Plugin } from '@deepseek-ai/cordis'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** HTTP host the desktop publishes its own surfaces on. */
    readonly webServer: {
      /** @returns The loopback origin the host answers on. */
      getOrigin(): string
      /**
       * Register one HTTP route.
       *
       * @param route - Path prefix and the handler that answers it.
       * @returns A disposer that removes the route.
       */
      register(route: {
        kind: 'prefix'
        path: string
        handler(req: IncomingMessage, res: ServerResponse): Promise<void> | void
      }): () => void
    }
    /** Peer admission the host applies to its own `/api` route. */
    readonly connection: {
      /**
       * Decide whether this peer may reach an authenticated surface.
       *
       * @param req - The request being admitted.
       * @returns The HTTP status to reject with, or undefined to admit it.
       */
      requestRejection(req: IncomingMessage): number | undefined
      /**
       * Mint a URL carrying the host's launch token.
       *
       * @param baseUrl - The host origin, without a path.
       * @returns The URL the bridge exchanges for a loopback cookie.
       */
      authenticatedUrl(baseUrl: string): string
    }
    /**
     * Run `callback` once every named service resolves, and re-run it when they
     * change.
     *
     * @param deps - Service names the callback reads.
     * @param callback - Body that registers the plugin's contributions.
     * @returns The fiber owning the injected plugin.
     */
    inject(deps: Inject, callback: Plugin.Function<void>): Fiber & PromiseLike<Fiber>
  }
}

export {}
