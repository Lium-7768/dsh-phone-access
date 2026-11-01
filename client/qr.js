/**
 * QR rendering for the pairing card.
 *
 * The payload is the JSON the native client parses (`version`, `gatewayUrl`,
 * `pairingId`, `pairingSecret`, `expiresAt`), so the code is rendered from the
 * server's RPC answer rather than assembled in the view.
 */
import qrcode from 'qrcode-generator'

/**
 * Render one payload as an inline SVG string.
 *
 * @param text - The pairing payload to encode.
 * @param options - Module size in pixels and quiet-zone width in modules.
 * @returns An `<svg>` element as markup, sized to its container.
 */
export function qrSvgMarkup(text, options = {}) {
  const { cellSize = 4, margin = 2 } = options
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize, margin, scalable: true })
}
