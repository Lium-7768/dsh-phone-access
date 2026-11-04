/**
 * Phone-access settings section.
 *
 * Reading order follows what a reader needs: whether the phone can connect right
 * now, the one action that needs no typing (the pairing QR), the fallback
 * credentials, then the choices and the devices already paired.
 *
 * Layout rules this file keeps: one primary action per card, a fixed label column
 * so values align, destructive actions drawn as outlines, and nothing that shifts
 * when a QR appears.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'

import { BRIDGE_ENDPOINTS } from './api.js'
import { qrSvgMarkup } from './qr.js'

/** Shortest password the server accepts, mirrored for inline feedback. */
const MIN_PASSWORD_LENGTH = 16

/**
 * Render the phone-access section.
 *
 * @param props - RPC caller and translator supplied by the slot registration.
 * @returns The section.
 */
export function MobileBridgeSection({ rpcCall, t }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(false)
  const [revealed, setRevealed] = useState(false)
  const [copied, setCopied] = useState('')
  const [busy, setBusy] = useState(false)
  const [pairing, setPairing] = useState(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [caps, setCaps] = useState(null)
  const [capsBusy, setCapsBusy] = useState(false)
  const [capsNote, setCapsNote] = useState('')
  const [passwordDraft, setPasswordDraft] = useState('')
  const [passwordNote, setPasswordNote] = useState({ kind: 'none', text: '' })
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.status, {})
      if (result?.ok !== true) throw new Error('status failed')
      setStatus(result.value)
      setError(false)
    } catch {
      // Keep the last good reading on screen; the poll retries.
      setError(true)
    }
  }, [rpcCall])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 4000)
    return () => clearInterval(timer)
  }, [load])

  useEffect(() => {
    if (status?.settings === undefined) return
    setCaps(previous => previous ?? { ...status.settings })
  }, [status])

  useEffect(() => {
    if (pairing === null) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [pairing])

  const copy = async (value, tag) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(tag)
      setTimeout(() => setCopied(''), 1500)
    } catch {
      // Clipboard permission is the browser's decision; the value stays selectable.
    }
  }

  const startPairing = async () => {
    setPairingBusy(true)
    setPairingError('')
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.createPairing, { label: t('qrDeviceLabel') })
      if (result?.ok === true) {
        setPairing(result.value)
        setNow(Date.now())
      } else {
        setPairingError(result?.error?.message ?? t('qrFailed'))
      }
    } catch {
      setPairingError(t('qrFailed'))
    } finally {
      setPairingBusy(false)
    }
  }

  const savePassword = async () => {
    const candidate = passwordDraft.trim()
    if (candidate.length < MIN_PASSWORD_LENGTH || /\s/.test(candidate)) {
      setPasswordNote({ kind: 'error', text: t('passwordInvalid') })
      return
    }
    setBusy(true)
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.setPassword, { password: candidate })
      if (result?.ok === true) {
        setPasswordDraft('')
        setRevealed(true)
        setPasswordNote({ kind: 'done', text: t('passwordSaved') })
        setTimeout(() => setPasswordNote({ kind: 'none', text: '' }), 2500)
        await load()
      } else {
        setPasswordNote({ kind: 'error', text: result?.error?.message ?? t('passwordInvalid') })
      }
    } catch {
      setPasswordNote({ kind: 'error', text: t('passwordInvalid') })
    } finally {
      setBusy(false)
    }
  }

  const randomPassword = async () => {
    if (!window.confirm(`${t('rotateConfirm')}\n\n${t('rotateConfirmBody')}`)) return
    setBusy(true)
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.rotatePassword, {})
      if (result?.ok === true) {
        setPasswordDraft('')
        setRevealed(true)
        setPasswordNote({ kind: 'done', text: t('passwordSaved') })
        setTimeout(() => setPasswordNote({ kind: 'none', text: '' }), 2500)
        await load()
      }
    } finally {
      setBusy(false)
    }
  }

  const applyCaps = async () => {
    if (caps === null) return
    setCapsBusy(true)
    setCapsNote('')
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.updateSettings, caps)
      if (result?.ok === true) {
        setStatus(result.value)
        setCaps({ ...result.value.settings })
        setCapsNote(t('capsSaved'))
        setTimeout(() => setCapsNote(''), 2000)
      } else {
        setCapsNote(result?.error?.message ?? t('failed'))
      }
    } catch {
      setCapsNote(t('failed'))
    } finally {
      setCapsBusy(false)
    }
  }

  const reconnectTunnel = async () => {
    setBusy(true)
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.reconnectTunnel, {})
      if (result?.ok === true) setStatus(result.value)
      else await load()
    } catch {
      await load()
    } finally {
      setBusy(false)
    }
  }

  const removeDevice = async deviceId => {
    if (!window.confirm(`${t('removeConfirm')}\n\n${t('removeConfirmBody')}`)) return
    setBusy(true)
    try {
      await rpcCall(BRIDGE_ENDPOINTS.deleteDevice, { deviceId })
      await load()
    } finally {
      setBusy(false)
    }
  }

  if (status === null) {
    return h('div', { style: S.wrap }, h('p', { style: S.muted }, error ? t('failed') : t('loading')))
  }

  const online = status.publicUrl !== null
  const devices = status.devices ?? []
  const address = status.publicUrl ?? status.lanUrl
  const remaining = pairing === null ? 0 : Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000))
  const expired = pairing !== null && remaining === 0

  return h(
    'div',
    { style: S.wrap },

    // Header: the one thing a reader checks first is whether the phone can reach
    // this computer, so the state sits beside the title rather than in a footer.
    h(
      'header',
      { style: S.header },
      h(
        'div',
        { style: S.titleRow },
        h('h2', { style: S.heading }, t('heading')),
        h(
          'span',
          { style: S.statePill },
          h('span', { style: online ? S.dotOn : S.dotOff }),
          h('span', { style: S.stateText }, online ? t('stateOnline') : t('stateOffline')),
        ),
      ),
      h('p', { style: S.intro }, online ? t('stateOnlineHint') : t('stateOfflineHint')),
      !online && status.tunnelError != null
        ? h(
            'div',
            { style: S.notice },
            h('span', { style: S.noticeText }, status.tunnelError),
            h(
              'button',
              {
                type: 'button',
                style: { ...S.linkButton, opacity: busy ? 0.6 : 1 },
                disabled: busy,
                onClick: () => void reconnectTunnel(),
              },
              t('tunnelRetry'),
            ),
          )
        : null,
    ),

    // Card: pairing. The QR slot keeps its height while empty, so pressing the
    // button fills the card instead of pushing the page around.
    h(
      'section',
      { style: S.card },
      h(
        'div',
        { style: S.cardHead },
        h('h3', { style: S.cardTitle }, t('scanCard')),
        h('span', { style: S.cardHint }, t('scanCardHint')),
      ),
      h(
        'div',
        { style: S.qrRow },
        h(
          'div',
          { style: S.qrSlot },
          pairing === null || expired
            ? h('div', { style: S.qrEmpty }, expired ? h('span', { style: S.qrEmptyText }, t('qrExpired')) : null)
            : h('div', {
                style: S.qrImage,
                dangerouslySetInnerHTML: { __html: qrSvgMarkup(JSON.stringify(pairing)) },
              }),
        ),
        h(
          'div',
          { style: S.qrSide },
          pairing === null || expired
            ? h('p', { style: S.body }, t('qrIntro'))
            : h(
                'div',
                { style: S.clockRow },
                h('span', { style: S.clockLabel }, t('qrExpires')),
                h(
                  'code',
                  { style: S.clock },
                  `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, '0')}`,
                ),
              ),
          pairing === null || expired ? null : h('code', { style: S.smallCode }, pairing.gatewayUrl),
          h(
            'div',
            { style: S.buttonRow },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.primary, opacity: pairingBusy ? 0.6 : 1 },
                disabled: pairingBusy,
                onClick: () => void startPairing(),
              },
              pairing === null || expired ? t('qrGenerate') : t('qrRefresh'),
            ),
          ),
          pairingError === '' ? null : h('p', { style: S.error }, pairingError),
          h('p', { style: S.footnote }, t('qrHint')),
        ),
      ),
    ),

    // Card: credentials. Values align on a fixed label column; the password field
    // lives under a disclosure, so the card stays two rows tall until it is needed.
    h(
      'section',
      { style: S.card },
      h('h3', { style: S.cardTitle }, t('linkCard')),
      h(
        'div',
        { style: S.kv },
        h('span', { style: S.kvLabel }, t('addressLabel')),
        h('code', { style: S.kvValue }, address ?? t('addressMissing')),
        address === null
          ? null
          : h(
              'button',
              { type: 'button', style: S.ghost, onClick: () => void copy(address, 'url') },
              copied === 'url' ? t('copied') : t('copy'),
            ),
      ),
      status.lanUrl === null
        ? null
        : h(
            'div',
            { style: S.kv },
            h('span', { style: S.kvLabel }, t('lanAddressLabel')),
            h('code', { style: S.kvValue }, status.lanUrl),
            h(
              'button',
              { type: 'button', style: S.ghost, onClick: () => void copy(status.lanUrl, 'lan') },
              copied === 'lan' ? t('copied') : t('copy'),
            ),
          ),
      h(
        'div',
        { style: S.kv },
        h('span', { style: S.kvLabel }, t('passwordLabel')),
        h('code', { style: S.kvValue }, revealed ? status.password : '•'.repeat(12)),
        h(
          'button',
          { type: 'button', style: S.ghost, onClick: () => setRevealed(value => !value) },
          revealed ? t('hide') : t('show'),
        ),
        h(
          'button',
          { type: 'button', style: S.ghost, onClick: () => void copy(status.password, 'pw') },
          copied === 'pw' ? t('copied') : t('copy'),
        ),
      ),

      h(
        'details',
        { style: S.disclosure },
        h('summary', { style: S.summary }, t('passwordChange')),
        h('p', { style: S.footnote }, t('passwordHelp')),
        h(
          'div',
          { style: S.editRow },
          h('input', {
            'aria-label': t('passwordEditLabel'),
            type: 'text',
            value: passwordDraft,
            placeholder: t('passwordEditPlaceholder'),
            style: S.input,
            onChange: event => {
              setPasswordDraft(event.target.value)
              if (passwordNote.kind !== 'none') setPasswordNote({ kind: 'none', text: '' })
            },
            onKeyDown: event => {
              if (event.key === 'Enter') void savePassword()
            },
          }),
          h(
            'button',
            {
              type: 'button',
              style: { ...S.primary, opacity: busy || passwordDraft.trim() === '' ? 0.6 : 1 },
              disabled: busy || passwordDraft.trim() === '',
              onClick: () => void savePassword(),
            },
            t('passwordSave'),
          ),
          h(
            'button',
            {
              type: 'button',
              style: { ...S.ghost, opacity: busy ? 0.6 : 1 },
              disabled: busy,
              onClick: () => void randomPassword(),
            },
            t('passwordRandom'),
          ),
        ),
        passwordNote.kind === 'none'
          ? null
          : h(
              'p',
              {
                'aria-live': 'polite',
                style: passwordNote.kind === 'error' ? S.error : S.ok,
              },
              passwordNote.text,
            ),
      ),
    ),

    // Card: how the phone may reach this computer.
    caps === null
      ? null
      : h(
          'section',
          { style: S.card },
          h('h3', { style: S.cardTitle }, t('capsCard')),
          h(
            'div',
            { style: S.kv },
            h('span', { style: S.kvLabel }, t('capsLan')),
            h(
              'label',
              { style: S.switchRow },
              h('input', {
                type: 'checkbox',
                checked: caps.lan,
                onChange: event => setCaps({ ...caps, lan: event.target.checked }),
              }),
              h('span', { style: S.switchText }, caps.lan ? t('capsOn') : t('capsOff')),
            ),
          ),
          h('p', { style: S.footnote }, t('capsLanHint')),
          h(
            'div',
            { style: S.kv },
            h('span', { style: S.kvLabel }, t('capsTunnel')),
            h(
              'select',
              {
                'aria-label': t('capsTunnel'),
                value: caps.tunnel,
                onChange: event => setCaps({ ...caps, tunnel: event.target.value }),
                style: S.select,
              },
              h('option', { value: 'off' }, t('capsTunnelNone')),
              h('option', { value: 'quick' }, t('capsTunnelQuick')),
              h('option', { value: 'named' }, t('capsTunnelNamed')),
            ),
          ),
          h(
            'p',
            { style: S.footnote },
            caps.tunnel === 'named'
              ? t('capsTunnelNamedHint')
              : caps.tunnel === 'quick'
                ? t('capsTunnelQuickHint')
                : t('capsTunnelNoneHint'),
          ),
          h(
            'div',
            { style: S.buttonRow },
            h(
              'button',
              {
                type: 'button',
                style: { ...S.primary, opacity: capsBusy ? 0.6 : 1 },
                disabled: capsBusy,
                onClick: () => void applyCaps(),
              },
              capsBusy ? t('loading') : t('capsSave'),
            ),
            capsNote === '' ? null : h('span', { style: S.ok }, capsNote),
          ),
        ),

    // Card: paired devices.
    h(
      'section',
      { style: S.card },
      h(
        'div',
        { style: S.cardHead },
        h('h3', { style: S.cardTitle }, t('devicesCard')),
        h('span', { style: S.cardHint }, `${String(devices.length)} ${t('devicesUnit')}`),
      ),
      devices.length === 0
        ? h('p', { style: S.footnote }, t('devicesEmpty'))
        : h(
            'ul',
            { style: S.list },
            ...devices.map(device =>
              h(
                'li',
                { key: device.deviceId, style: S.listItem },
                h('span', { style: S.deviceLabel }, device.label),
                h('span', { style: S.deviceTime }, new Date(device.createdAt).toLocaleString()),
                h(
                  'button',
                  {
                    type: 'button',
                    style: { ...S.danger, opacity: busy ? 0.6 : 1 },
                    disabled: busy,
                    onClick: () => void removeDevice(device.deviceId),
                  },
                  t('deviceRemove'),
                ),
              ),
            ),
          ),
    ),
  )
}

/** Inline styles keep the section self-contained: it ships without a CSS build. */
const S = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '18px', padding: '2px 0', maxWidth: '680px' },
  header: { display: 'flex', flexDirection: 'column', gap: '6px' },
  titleRow: { display: 'flex', alignItems: 'center', gap: '10px' },
  heading: { fontSize: '16px', fontWeight: 600, margin: 0, letterSpacing: '.01em' },
  statePill: { display: 'inline-flex', alignItems: 'center', gap: '6px' },
  stateText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },
  dotOn: { width: '6px', height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-state-success-primary)' },
  dotOff: { width: '6px', height: '6px', borderRadius: '999px', background: 'var(--dsw-alias-label-caption)' },
  intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px', lineHeight: '20px' },
  notice: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    padding: '8px 10px',
    borderRadius: '8px',
    background: 'var(--dsw-alias-state-error-secondary)',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  noticeText: { flex: '1 1 auto', minWidth: 0, fontSize: '12px', lineHeight: '18px', wordBreak: 'break-word' },
  linkButton: {
    flex: 'none',
    padding: '3px 8px',
    fontSize: '12px',
    borderRadius: '6px',
    cursor: 'pointer',
    border: '0.5px solid currentColor',
    background: 'transparent',
    color: 'inherit',
  },

  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '16px',
    borderRadius: '12px',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardHead: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '10px' },
  cardTitle: { fontSize: '13px', fontWeight: 600, margin: 0, color: 'var(--dsw-alias-label-primary)' },
  cardHint: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },

  qrRow: { display: 'flex', alignItems: 'flex-start', gap: '18px' },
  qrSlot: {
    width: '168px',
    height: '168px',
    flex: 'none',
    borderRadius: '10px',
    background: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '0.5px dashed var(--dsw-alias-border-l3)',
  },
  qrEmpty: { padding: '0 12px', textAlign: 'center' },
  qrEmptyText: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: '18px' },
  qrImage: { width: '160px', height: '160px' },
  qrSide: { display: 'flex', flexDirection: 'column', gap: '8px', flex: '1 1 auto', minWidth: 0 },
  clockRow: { display: 'flex', alignItems: 'baseline', gap: '8px' },
  clockLabel: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  clock: {
    fontSize: '20px',
    fontWeight: 600,
    fontVariantNumeric: 'tabular-nums',
    color: 'var(--dsw-alias-label-primary)',
  },
  smallCode: {
    fontSize: '11px',
    color: 'var(--dsw-alias-label-tertiary)',
    wordBreak: 'break-all',
    fontFamily: 'var(--ds-font-mono, ui-monospace, Menlo, monospace)',
  },
  body: { margin: 0, fontSize: '13px', lineHeight: '20px', color: 'var(--dsw-alias-label-secondary)' },

  kv: { display: 'flex', alignItems: 'center', gap: '10px', minHeight: '30px' },
  kvLabel: { flex: '0 0 72px', fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  kvValue: {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '13px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    fontFamily: 'var(--ds-font-mono, ui-monospace, Menlo, monospace)',
    color: 'var(--dsw-alias-label-primary)',
  },
  switchRow: { display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' },
  switchText: { fontSize: '12px', color: 'var(--dsw-alias-label-secondary)' },

  primary: {
    flex: 'none',
    padding: '6px 14px',
    fontSize: '12px',
    fontWeight: 500,
    borderRadius: '8px',
    cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)',
    color: 'var(--dsw-alias-label-primary-inverted)',
  },
  ghost: {
    flex: 'none',
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '8px',
    cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-button-elevated-fill)',
    color: 'var(--dsw-alias-label-primary)',
  },
  danger: {
    flex: 'none',
    padding: '4px 10px',
    fontSize: '12px',
    borderRadius: '8px',
    cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-state-error-secondary)',
    background: 'transparent',
    color: 'var(--dsw-alias-state-error-primary)',
  },
  select: {
    flex: '0 0 132px',
    padding: '5px 8px',
    fontSize: '12px',
    borderRadius: '8px',
    cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-button-elevated-fill)',
    color: 'var(--dsw-alias-label-primary)',
  },
  buttonRow: { display: 'flex', alignItems: 'center', gap: '10px' },

  disclosure: { marginTop: '2px' },
  summary: {
    cursor: 'pointer',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-secondary)',
    padding: '4px 0',
    listStyle: 'revert',
  },
  editRow: { display: 'flex', alignItems: 'center', gap: '8px', marginTop: '6px' },
  input: {
    flex: '1 1 auto',
    minWidth: 0,
    padding: '7px 10px',
    fontSize: '13px',
    borderRadius: '8px',
    border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-base)',
    color: 'var(--dsw-alias-label-primary)',
  },

  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column' },
  listItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '9px 0',
    borderTop: '0.5px solid var(--dsw-alias-border-l3)',
  },
  deviceLabel: {
    flex: '1 1 auto',
    minWidth: 0,
    fontSize: '13px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  deviceTime: {
    flex: 'none',
    fontSize: '12px',
    color: 'var(--dsw-alias-label-tertiary)',
    fontVariantNumeric: 'tabular-nums',
  },

  footnote: { margin: 0, fontSize: '12px', lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
  muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' },
  ok: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-success-primary)' },
  error: { margin: 0, fontSize: '12px', color: 'var(--dsw-alias-state-error-primary)', lineHeight: '18px' },
}
