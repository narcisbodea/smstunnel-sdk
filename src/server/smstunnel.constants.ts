export const SMSTUNNEL_OPTIONS = 'SMSTUNNEL_OPTIONS';

export const SMSTUNNEL_DEFAULT_PREFIX = 'smstunnel';

/**
 * Public paths that should be excluded from auth guards.
 * Use with your global guard to skip auth on callback/polling routes.
 * The last one, the older WordPress-style callback, is mounted only with `enableLegacyCallback: true`.
 *
 * Example (NestJS):
 *   if (SMSTUNNEL_PUBLIC_PATHS.some(p => request.url.includes(p))) return true;
 */
export const SMSTUNNEL_PUBLIC_PATHS = [
  '/smstunnel/pairing-status/',
  '/smstunnel/callback',
  '/wp-json/smstunnel/v1/setup-callback',
];

/**
 * Returns public paths with a custom prefix.
 */
export function getSmsTunnelPublicPaths(prefix: string): string[] {
  return [
    `/${prefix}/pairing-status/`,
    `/${prefix}/callback`,
    '/wp-json/smstunnel/v1/setup-callback',
  ];
}
