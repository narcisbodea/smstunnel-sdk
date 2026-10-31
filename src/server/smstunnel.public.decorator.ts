import { SetMetadata } from '@nestjs/common';

/**
 * Metadata key used to mark a route as public (no auth required).
 * The built-in {@link SmsTunnelAuthGuard} reads this via Reflector.
 */
export const SMSTUNNEL_IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a controller route as public so the built-in
 * {@link SmsTunnelAuthGuard} allows it without authentication.
 *
 * All other SMSTunnel routes are protected by default (secure-by-default):
 * they require the auth strategy configured in `SmsTunnelModule.forRoot()`.
 */
export function SmsTunnelPublic(): MethodDecorator & ClassDecorator {
  return SetMetadata(SMSTUNNEL_IS_PUBLIC_KEY, true);
}
