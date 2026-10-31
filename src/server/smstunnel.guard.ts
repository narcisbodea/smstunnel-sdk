import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SMSTUNNEL_OPTIONS } from './smstunnel.constants';
import { SMSTUNNEL_IS_PUBLIC_KEY } from './smstunnel.public.decorator';
import type { SmsTunnelModuleOptions } from './smstunnel.interfaces';

/**
 * Built-in auth guard for the SMSTunnel controller routes.
 *
 * Secure-by-default behaviour:
 *  - Routes decorated with `@SmsTunnelPublic()` are always allowed
 *    (callback / polling proxy / legacy WP callback).
 *  - Every other route requires authentication. The consumer supplies the
 *    strategy through `SmsTunnelModule.forRoot({ authenticate })` or
 *    `{ authGuard }`.
 *  - If NO auth strategy is configured, non-public routes are REJECTED
 *    (fail-closed) instead of being silently exposed.
 *
 * The guard is registered automatically by the module (via `@UseGuards`
 * on the controller) so consumers do not need to wire it up themselves.
 */
@Injectable()
export class SmsTunnelAuthGuard implements CanActivate {
  private readonly logger = new Logger(SmsTunnelAuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    @Inject(SMSTUNNEL_OPTIONS)
    private readonly options: SmsTunnelModuleOptions,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // Public routes (callback, polling proxy, legacy WP callback) bypass auth.
    const isPublic = this.reflector.getAllAndOverride<boolean>(
      SMSTUNNEL_IS_PUBLIC_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest();

    // 1. Consumer-provided full guard delegate.
    if (this.options.authGuard) {
      return this.runDelegateGuard(context);
    }

    // 2. Consumer-provided authenticate(req) predicate.
    if (typeof this.options.authenticate === 'function') {
      try {
        const ok = await this.options.authenticate(request);
        return ok === true;
      } catch (err: any) {
        this.logger.warn(
          `SMSTunnel: authenticate() threw for ${request?.method} ${request?.url} - denying. ${err?.message ?? err}`,
        );
        return false;
      }
    }

    // 3. No strategy configured -> fail closed.
    this.logger.warn(
      `SMSTunnel: blocked ${request?.method ?? ''} ${request?.url ?? ''} - no auth strategy configured. ` +
        'Provide authenticate() (or authGuard) in SmsTunnelModule.forRoot().',
    );
    return false;
  }

  /**
   * Delegate to a consumer-provided NestJS CanActivate (class or instance).
   * We instantiate plain classes; if the consumer needs DI in their guard
   * they should use the `authenticate(req)` predicate instead.
   */
  private async runDelegateGuard(
    context: ExecutionContext,
  ): Promise<boolean> {
    const provided = this.options.authGuard as any;
    let guard: CanActivate;

    if (typeof provided === 'function') {
      // A class/constructor was supplied.
      try {
        guard = new provided();
      } catch {
        // Maybe it's already an instance-producing factory; treat as instance.
        guard = provided as CanActivate;
      }
    } else {
      guard = provided as CanActivate;
    }

    if (!guard || typeof guard.canActivate !== 'function') {
      this.logger.warn(
        'SMSTunnel: authGuard is invalid (no canActivate) - denying request.',
      );
      return false;
    }

    const result = await guard.canActivate(context);
    // canActivate may return Observable in NestJS; coerce common cases.
    if (typeof (result as any)?.subscribe === 'function') {
      return await new Promise<boolean>((resolve) => {
        (result as any).subscribe({
          next: (v: boolean) => resolve(v === true),
          error: () => resolve(false),
        });
      });
    }
    return (await result) === true;
  }
}
