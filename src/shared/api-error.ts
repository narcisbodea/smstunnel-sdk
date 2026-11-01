/**
 * How SMSTunnel answers when a call doesn't go through, in one shape for the Node client and the NestJS module.
 * Plain TypeScript, no Node built-ins, so any entry point can use it.
 */

/** The fields SMSTunnel puts in an error body. `code` is there for the errors your software can act on. */
export interface SmsTunnelErrorBody {
  statusCode?: number;
  /** A short label, such as `Forbidden`, or older bodies' message. */
  error?: string;
  /** What went wrong, in words. A list when several fields were refused. */
  message?: string | string[];
  /**
   * Set on errors your software can act on, for example:
   * - `PERMISSION_REQUIRED`: the API key lacks a permission (see `permission`), such as `sms:inbox` for received texts.
   * - `CONCURRENT_ACTIVATION` / `ALREADY_CONNECTED`: two Enterprise activations of one client overlapped.
   * - `DISABLED_BY_SUPPORT`: SMSTunnel support turned the key or the phone off.
   */
  code?: string;
  /** With `PERMISSION_REQUIRED`: the permission the key lacks. */
  permission?: string;
  [key: string]: unknown;
}

/** The words of an error body, whatever its shape. */
export function errorMessageOf(body: unknown, status: number): string {
  if (typeof body === 'string' && body.trim()) return body.trim().slice(0, 300);
  const fields = (body && typeof body === 'object' ? body : {}) as SmsTunnelErrorBody;
  const message = Array.isArray(fields.message) ? fields.message.join('; ') : fields.message;
  return message || fields.error || `SMSTunnel returned error: ${status}`;
}

/**
 * Thrown by `SmsTunnelNodeClient` when SMSTunnel answers with an error status. It is still an `Error` with the
 * same message as before 2.1.0, and it also carries the status, the code and the body.
 *
 * Statuses worth handling:
 * - 401: the API key is wrong, expired, or its account is suspended.
 * - 403: the key lacks a permission (`code: 'PERMISSION_REQUIRED'`), or the text needs a higher plan (Maximum
 *   privacy: an encrypted text without `to`, or a sealed one, needs Professional or Enterprise).
 * - 404: no such message or phone for this key.
 * - 429: too many requests, or the daily limit for encrypted texts is reached.
 */
export class SmsTunnelApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly permission?: string;
  readonly body: unknown;

  constructor(status: number, body: unknown) {
    super(errorMessageOf(body, status));
    this.name = 'SmsTunnelApiError';
    this.status = status;
    this.body = body;
    if (body && typeof body === 'object') {
      const fields = body as SmsTunnelErrorBody;
      if (typeof fields.code === 'string') this.code = fields.code;
      if (typeof fields.permission === 'string') this.permission = fields.permission;
    }
  }
}

/**
 * The NestJS module returns failures instead of throwing. This is that object: the body SMSTunnel sent, plus
 * `success: false`, the HTTP `status`, and `error` in words (before 2.1.0, `error` was often only `Forbidden`).
 */
export interface SmsTunnelFailure extends SmsTunnelErrorBody {
  success: false;
  status: number;
  error: string;
}

export function failureOf(status: number, body: unknown): SmsTunnelFailure {
  const fields = body && typeof body === 'object' && !Array.isArray(body) ? (body as SmsTunnelErrorBody) : {};
  return { ...fields, success: false, status, error: errorMessageOf(body, status) };
}

/** Reads a response body as JSON, or as text when it isn't JSON (a proxy's error page, for instance). */
export async function readBody(res: { text(): Promise<string> }): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
