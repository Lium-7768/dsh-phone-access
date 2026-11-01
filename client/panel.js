/**
 * Right-side panel: the same facts as the Settings section, sized for a narrow
 * column. The pairing QR leads because it is the only path that needs no typing;
 * the address, password and device list follow as read-and-copy rows.
 */
import { createElement as h, useCallback, useEffect, useState } from 'react'

import { BRIDGE_ENDPOINTS } from './api.js'
import { qrSvgMarkup } from './qr.js'

/**
 * Render the right-pane panel.
 *
 * @param props - RPC caller and translator supplied by the tab registration.
 * @returns The panel body.
 */
export function PhonePanel({ rpcCall, t }) {
  const [status, setStatus] = useState(null)
  const [error, setError] = useState(false)
  const [copied, setCopied] = useState('')
  const [pairing, setPairing] = useState(null)
  const [pairingBusy, setPairingBusy] = useState(false)
  const [pairingError, setPairingError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    try {
      const result = await rpcCall(BRIDGE_ENDPOINTS.status, {})
      if (result?.ok !== true) throw new Error('status failed')
      setStatus(result.value)
      setError(false)
    } catch {
      setError(true)
    }
  }, [rpcCall])

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), 5000)
    return () => clearInterval(timer)
  }, [load])

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
      // Clipboard permission is the browser's decision.
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

  if (status === null) {
    return h('div', { style: S.wrap }, h('p', { style: S.muted }, error ? t('failed') : t('loading')))
  }

  const tunnelText = status.tunnelConnected === true
    ? t('tunnelConnected')
    : status.tunnelRunning === true ? t('tunnelConnecting') : t('tunnelUnavailable')
  const address = status.publicUrl ?? status.lanUrl
  const devices = status.devices ?? []

  return h('div', { style: S.wrap },
    h('section', { style: S.card },
      h('div', { style: S.cardHead },
        h('h3', { style: S.cardTitle }, t('scanCard')),
        h('button', {
          type: 'button', style: { ...S.primary, opacity: pairingBusy ? 0.6 : 1 }, disabled: pairingBusy,
          onClick: () => void startPairing(),
        }, pairing === null ? t('qrGenerate') : t('qrRefresh')),
      ),
      pairing === null
        ? (pairingError === '' ? h('p', { style: S.hint }, t('qrIntro')) : h('p', { style: S.error }, pairingError))
        : (() => {
          const expired = Date.parse(pairing.expiresAt) <= now
          const remaining = Math.max(0, Math.ceil((Date.parse(pairing.expiresAt) - now) / 1000))
          if (expired) return h('p', { style: S.error }, t('qrExpired'))
          return h('div', { style: S.qrBody },
            h('div', {
              style: S.qrImage,
              dangerouslySetInnerHTML: { __html: qrSvgMarkup(JSON.stringify(pairing), { cellSize: 3 }) },
            }),
            h('div', { style: S.qrMeta },
              h('code', { style: S.countdown },
                `${String(Math.floor(remaining / 60))}:${String(remaining % 60).padStart(2, '0')}`),
              h('code', { style: S.code }, pairing.gatewayUrl),
            ),
          )
        })(),
    ),

    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, t('linkCard')),
      h('div', { style: S.field },
        h('span', { style: S.label }, t('addressLabel')),
        h('code', { style: S.code }, address ?? t('addressMissing')),
        address === null ? null : h('button', {
          type: 'button', style: S.ghost, onClick: () => void copy(address, 'url'),
        }, copied === 'url' ? t('copied') : t('copy')),
      ),
      h('div', { style: S.field },
        h('span', { style: S.label }, t('passwordLabel')),
        h('code', { style: S.code }, t('passwordHidden')),
        h('button', { type: 'button', style: S.ghost, onClick: () => void copy(status.password, 'pw') },
          copied === 'pw' ? t('copied') : t('copy')),
      ),
      h('p', { style: S.hint }, t('passwordHelp')),
    ),

    h('section', { style: S.card },
      h('h3', { style: S.cardTitle }, `${t('devicesCard')} · ${String(devices.length)}`),
      devices.length === 0
        ? h('p', { style: S.muted }, t('devicesEmpty'))
        : h('ul', { style: S.list }, ...devices.map(device => h('li', { key: device.deviceId, style: S.listItem },
          h('span', { style: S.deviceLabel }, device.label),
          h('span', { style: S.deviceMeta }, new Date(device.createdAt).toLocaleDateString()),
        ))),
      h('p', { style: S.hint }, `${t('tunnelLabel')}：${status.hostname ?? status.publicUrl ?? '—'} · ${tunnelText}`),
    ),
  )
}

/** Inline styles keep the panel self-contained: it ships without a CSS build. */
const S = {
  wrap: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px', maxWidth: '100%' },
  card: {
    display: 'flex', flexDirection: 'column', gap: '8px', padding: '12px',
    borderRadius: '12px', border: '0.5px solid var(--dsw-alias-border-l3)',
    background: 'var(--dsw-alias-bg-layer-1)',
  },
  cardHead: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' },
  cardTitle: { fontSize: '13px', fontWeight: 600, margin: 0 },
  primary: {
    flex: 'none', padding: '4px 10px', fontSize: '12px', fontWeight: 500, borderRadius: '8px',
    cursor: 'pointer', border: '0.5px solid var(--dsw-alias-brand-primary)',
    background: 'var(--dsw-alias-brand-primary)', color: 'var(--dsw-alias-label-primary-inverted)',
  },
  ghost: {
    alignSelf: 'flex-start', padding: '3px 9px', fontSize: '12px', borderRadius: '8px', cursor: 'pointer',
    border: '0.5px solid var(--dsw-alias-border-l3)', background: 'var(--dsw-alias-button-elevated-fill)',
    color: 'var(--dsw-alias-label-primary)',
  },
  field: { display: 'flex', flexDirection: 'column', gap: '3px' },
  label: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)' },
  code: {
    fontSize: '12px', wordBreak: 'break-all', color: 'var(--dsw-alias-label-primary)',
    fontFamily: 'var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  },
  countdown: { fontSize: '18px', fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
  qrBody: { display: 'flex', gap: '10px', alignItems: 'flex-start' },
  qrImage: { width: '120px', height: '120px', background: '#fff', borderRadius: '8px', padding: '4px', flex: 'none' },
  qrMeta: { display: 'flex', flexDirection: 'column', gap: '4px', minWidth: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '4px' },
  listItem: { display: 'flex', alignItems: 'center', gap: '8px' },
  deviceLabel: { fontSize: '13px', flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  deviceMeta: { fontSize: '12px', color: 'var(--dsw-alias-label-tertiary)', flex: 'none' },
  hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '12px', lineHeight: '18px' },
  muted: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: '13px' },
  error: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: '12px' },
}
