/**
 * Scheduled texts (`POST /api/v1/sms/send` with `sendAt`): the types SMSTunnel answers with, and the `sendAt` it
 * takes. Plain TypeScript, no Node built-ins, so the Node client and the NestJS module share it.
 */

/** `scheduled` until its time; then `sent` (handed to the phone: follow `messageId`), `failed` or `canceled`. */
export type ScheduledTextStatus = 'scheduled' | 'sent' | 'failed' | 'canceled';

/**
 * Why a scheduled text did not go out at its time. A failed text is never retried on its own.
 * - `key_not_active`: the key that scheduled it was stopped, deleted or expired, or may no longer send.
 * - `limit_reached`: the plan's allowance for that day was used up.
 * - `invalid_number`: the number couldn't be read with the country code of that moment.
 * - `phone_not_found`, `phone_unlinked`, `sealed_only_phone`: the phone was gone, had stopped such texts, or sends
 *   only end-to-end encrypted texts.
 * - `interrupted`: SMSTunnel stopped while handing it over; it is failed rather than risk sending it twice.
 */
export type ScheduledTextError =
  | 'key_not_active'
  | 'limit_reached'
  | 'invalid_number'
  | 'phone_not_found'
  | 'phone_unlinked'
  | 'sealed_only_phone'
  | 'number_not_allowed'
  | 'account_not_active'
  | 'interrupted'
  | 'failed';

/** A text SMSTunnel keeps to send later, as the API key that scheduled it sees it. */
export interface ScheduledText {
  id: string;
  /** The number as it was given. */
  to: string;
  message: string;
  /** When it goes out (or went out), ISO 8601 in UTC. */
  sendAt: string;
  status: ScheduledTextStatus;
  /** The phone named when it was scheduled; `null`: the default phone of the moment it goes out. */
  deviceId: string | null;
  /** Set once it went out: its delivery is the usual message status. */
  messageId: string | null;
  /** Why it failed; `null` otherwise. */
  error: ScheduledTextError | null;
  createdAt: string;
}

/** A page of the texts this API key scheduled. */
export interface ScheduledTextsPage {
  items: ScheduledText[];
  total: number;
  page: number;
  limit: number;
  /** How many texts wait in the whole account (the dashboard's and other keys' too). */
  waiting: number;
  /** The plan's cap on texts waiting at once: Free 10, Starter 50, Standard 200, Professional 500, Enterprise 1000. */
  max: number;
}

/** Which scheduled texts to list. */
export interface ListScheduledQuery {
  /**
   * `waiting` (the default): the ones that haven't gone out yet, soonest first. `done`: sent, failed or canceled,
   * newest first, kept 30 days.
   */
  scope?: 'waiting' | 'done';
  /** From 1. */
  page?: number;
  /** 1 to 100; SMSTunnel's default is 50. */
  limit?: number;
}

// YYYY-MM-DD, T (or a space), hh:mm, optional :ss and a fraction, then the offset: Z, ±hh:mm, ±hhmm or ±hh.
const ISO_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

const EXAMPLE = '2026-11-16T09:00:00+02:00';

/**
 * The `sendAt` SMSTunnel gets, always as `toISOString()` (UTC). Takes a `Date`, or an ISO 8601 date and time with its
 * offset: `2026-11-16T09:00:00+02:00`, `2026-11-16T07:00Z`, `2026-11-16 09:00:00.250-0500`.
 *
 * Throws a `TypeError` for anything else, before any call: an invalid `Date`, a string without its offset (it would
 * be read in some other time zone), or a date that doesn't exist, such as 30 February (`new Date()` would quietly
 * turn it into 2 March). Whether it is 1 minute to 30 days ahead is left to SMSTunnel, whose clock decides.
 */
export function sendAtOf(value: unknown): string {
  if (isDate(value)) {
    const time = Date.prototype.getTime.call(value);
    if (Number.isNaN(time)) throw new TypeError('sendAt is an invalid Date.');
    return new Date(time).toISOString();
  }
  if (typeof value !== 'string') {
    throw new TypeError(`sendAt must be a Date or an ISO 8601 date and time with its offset, such as "${EXAMPLE}".`);
  }

  const parts = ISO_DATE_TIME.exec(value.trim());
  if (!parts) {
    throw new TypeError(`sendAt "${preview(value)}" is not an ISO 8601 date and time, such as "${EXAMPLE}".`);
  }
  const [, year, month, day, hour, minute, second = '00', fraction = '', zulu, sign, offsetHours = '00', offsetMinutes = '00'] =
    parts;
  if (!zulu && !sign) {
    throw new TypeError(
      `sendAt "${preview(value)}" has no offset: add Z for UTC, or the offset of its time zone, such as "${EXAMPLE}".`,
    );
  }

  // The time as if it were UTC. Only a date that reads back the same exists: Date.parse turns 30 February into
  // 2 March and 24:00 into the next day.
  const wall = `${year}-${month}-${day}T${hour}:${minute}:${second}.${(fraction + '000').slice(0, 3)}Z`;
  const at = Date.parse(wall);
  if (Number.isNaN(at) || new Date(at).toISOString() !== wall || Number(offsetHours) > 23 || Number(offsetMinutes) > 59) {
    throw new TypeError(`sendAt "${preview(value)}" is not a real date and time, such as "${EXAMPLE}".`);
  }
  const offset = sign ? (sign === '-' ? -1 : 1) * (Number(offsetHours) * 60 + Number(offsetMinutes)) : 0;
  return new Date(at - offset * 60_000).toISOString();
}

/** A Date, also one made in another realm (a `vm` context, an iframe). */
function isDate(value: unknown): value is Date {
  return value instanceof Date || Object.prototype.toString.call(value) === '[object Date]';
}

function preview(value: string): string {
  return value.length > 40 ? `${value.slice(0, 40)}…` : value;
}

/** The path of one scheduled text; a `TypeError` for an id that can't be one (an empty one would name the list). */
export function scheduledPathOf(scheduledId: unknown): string {
  if (typeof scheduledId !== 'string' || !scheduledId.trim()) {
    throw new TypeError('scheduledId must be the id of a scheduled text (scheduledId from sendSms() with sendAt).');
  }
  return `/api/v1/sms/scheduled/${encodeURIComponent(scheduledId.trim())}`;
}

/** The query string of `GET /api/v1/sms/scheduled`; a `TypeError` for a scope SMSTunnel doesn't know. */
export function scheduledListQueryOf(query?: ListScheduledQuery): string {
  const params = new URLSearchParams();
  if (query?.scope !== undefined) {
    if (query.scope !== 'waiting' && query.scope !== 'done') {
      throw new TypeError(`scope must be 'waiting' or 'done' (got ${JSON.stringify(query.scope)}).`);
    }
    params.set('scope', query.scope);
  }
  if (query?.page) params.set('page', String(query.page));
  if (query?.limit) params.set('limit', String(query.limit));
  const qs = params.toString();
  return `/api/v1/sms/scheduled${qs ? `?${qs}` : ''}`;
}
