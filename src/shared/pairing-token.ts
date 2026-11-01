/**
 * The pairing token inside a v2 QR code (base64 of `{ s, t, n, v }`), if that's what it is. Node-only (Buffer).
 *
 * It is the token the phone pairs with: the one the `pairing_completed` callback carries and the one
 * `GET /api/v1/pairing/:token` answers to. In the Enterprise flow, `activation.token` is only an older reference.
 */
export function pairingTokenOf(qrData: string | undefined): string | undefined {
  if (!qrData) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(qrData, 'base64').toString('utf8'));
    return typeof parsed?.t === 'string' && parsed.t ? parsed.t : undefined;
  } catch {
    return undefined;
  }
}
