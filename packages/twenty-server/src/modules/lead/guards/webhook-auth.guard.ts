import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';

import { type Request } from 'express';

@Injectable()
export class WebhookAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const expectedSecret = process.env.LEAD_WEBHOOK_SECRET;

    // If no secret is configured, allow all requests for easy setup
    if (!expectedSecret) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const providedSecret = request.headers['x-webhook-secret'] as
      | string
      | undefined;

    if (!providedSecret) {
      throw new UnauthorizedException(
        'Missing x-webhook-secret header',
      );
    }

    if (providedSecret !== expectedSecret) {
      throw new UnauthorizedException(
        'Invalid webhook secret',
      );
    }

    return true;
  }
}
