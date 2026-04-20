import { createHmac, timingSafeEqual } from 'crypto';

import {
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';

import { type Request } from 'express';

// Verifies JustCall webhook requests using HMAC-SHA256 against the raw body.
// JustCall sends the signature in the `x-justcall-signature` header (hex).
//
// Env: JUSTCALL_WEBHOOK_SECRET — configured in JustCall webhook UI.
// If not configured (dev), requests are allowed to pass (matches WebhookAuthGuard).

type RawBodyRequest = Request & { rawBody?: Buffer };

@Injectable()
export class JustcallSignatureGuard implements CanActivate {
  private readonly logger = new Logger(JustcallSignatureGuard.name);

  canActivate(context: ExecutionContext): boolean {
    const secret = process.env.JUSTCALL_WEBHOOK_SECRET;

    if (!secret) {
      this.logger.warn(
        'JUSTCALL_WEBHOOK_SECRET not set — accepting webhook without verification',
      );

      return true;
    }

    const request = context.switchToHttp().getRequest<RawBodyRequest>();
    const signatureHeader =
      (request.headers['x-justcall-signature'] as string | undefined) ??
      (request.headers['x-signature'] as string | undefined);

    if (!signatureHeader) {
      throw new UnauthorizedException('Missing x-justcall-signature header');
    }

    const rawBody = request.rawBody
      ? request.rawBody
      : Buffer.from(JSON.stringify(request.body ?? {}));

    const expected = createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');

    const provided = signatureHeader.replace(/^sha256=/, '');

    if (
      provided.length !== expected.length ||
      !timingSafeEqual(Buffer.from(provided, 'hex'), Buffer.from(expected, 'hex'))
    ) {
      throw new UnauthorizedException('Invalid JustCall signature');
    }

    return true;
  }
}
