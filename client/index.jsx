/**
 * Browser half: a Settings section, a right-side panel, and the /phone command.
 *
 * The section is the one required registration; the panel and the command are
 * optional, so a host that lacks the right pane still gets the settings page
 * instead of failing to boot.
 */
import { BRIDGE_ENDPOINTS, BRIDGE_RPC_CHANNEL } from './api.js'
import { PhonePanel } from './panel.js'
import { MobileBridgeSection } from './section.js'
import { en, NS, zh } from './locales.js'

/** Right-pane page type, used as both the tab key and the resource type. */
const RESOURCE_TYPE = 'phone-access'

/** Cordis plugin name, matching the package name the bundle patch names. */
export const name = 'dsh-phone-access'

/**
 * Services this browser half needs.
 *
 * `sidebarRightTabs` is what makes an address openable at all: without a type
 * registered there, `openResource` rejects the address and the /phone command
 * has nowhere to put the panel. `sidebarRight` is the navigation controller the
 * command calls.
 */
export const inject = ['slots', 'connection', 'locale', 'sidebarRightTabs', 'sidebarRight']

/**
 * Register the Settings section, the right panel, and the /phone command.
 *
 * @param ctx - The browser plugin context.
 */
export function apply(ctx) {
  const translate = ctx.locale.bind(NS)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'phone-access: dictionaries')

  const rpcCall = (endpoint, payload) => ctx.connection.rpc.call(BRIDGE_RPC_CHANNEL, endpoint, payload)
  const injected = () => ({ rpcCall, t: translate })

  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'phone-access',
      order: 2,
      label: () => translate('nav'),
      inject: injected,
    },
    MobileBridgeSection,
  ))

  // The panel and the command live in session scope. Registering them is
  // best-effort: a host without the right pane must still show the section.
  try {
    // Stage one: the tab type. Address routing runs through this registry, so a
    // body registered without it is unreachable — the type is what claims the
    // address the command opens.
    ctx.effect(() => ctx.sidebarRightTabs.register({
      id: RESOURCE_TYPE,
      kind: RESOURCE_TYPE,
      patterns: [`dsh-resource://${RESOURCE_TYPE}/**`],
      title: address => panelTitle(address, translate),
    }), 'phone-access: tab type')
    // Stage two: the body, keyed by the type's id.
    ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab', key: RESOURCE_TYPE, locale: NS, inject: injected },
      PhonePanel,
    ))
    ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register(
      { name: 'sidebar.right.pane.tab.title', key: RESOURCE_TYPE },
      () => translate('nav'),
    ))
  } catch (error) {
    console.warn('phone-access: right pane unavailable', error)
  }

  ctx.inject(['commandUi'], scope => {
    const commands = scope.commandUi
    if (commands === undefined) return
    ctx.effect(() => commands.register({
      name: 'phone',
      label: () => translate('commandLabel'),
      description: () => translate('commandDescription'),
      available: () => true,
      ui: {
        kind: 'action',
        run: session => {
          const id = session?.sessionId ?? session?.id
          if (id === undefined) return
          try {
            ctx.sidebarRight.openResource(
              `dsh-resource://${RESOURCE_TYPE}/${encodeURIComponent(String(id))}/panel`,
            )
          } catch (error) {
            console.warn('phone-access: cannot open the panel', error)
          }
        },
      },
    }), 'phone-access: /phone command')
  })
}

/**
 * Chip title for one panel tab, named after the session it belongs to.
 *
 * @param address - the `dsh-resource://phone-access/...` address being opened.
 * @param translate - the section's copy lookup.
 * @returns the tab title in the current language.
 */
function panelTitle(address, translate) {
  const label = translate('nav')
  try {
    const sessionId = new URL(address).pathname.split('/').filter(Boolean)[0]
    return sessionId === undefined ? label : `${label} · ${decodeURIComponent(sessionId).slice(0, 8)}`
  } catch (error) {
    console.warn('phone-access: cannot name the panel tab', error)
    return label
  }
}

export { BRIDGE_ENDPOINTS }
