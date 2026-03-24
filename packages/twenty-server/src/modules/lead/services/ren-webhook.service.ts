import { Injectable, Logger } from '@nestjs/common';

import {
  type RenStatusWebhookPayload,
  type RenWebhookPayload,
  type RenWebhookResponse,
} from 'src/modules/lead/dtos/webhook.dto';

// REN webhook — fires on two events:
//   1. call.booked            — customer books a call (affiliate/referral + MRR)
//   2. customer.status_changed — customer payment status changes (ACTIVE / INACTIVE / PAUSED)
//
// Environment variables:
//   REN_WEBHOOK_URL    — target URL (required, skips silently if unset)
//   REN_WEBHOOK_SECRET — optional shared secret sent in x-ren-secret header

@Injectable()
export class RenWebhookService {
  private readonly logger = new Logger(RenWebhookService.name);

  async sendCallBooked(payload: RenWebhookPayload): Promise<RenWebhookResponse> {
    const targetUrl = process.env.REN_WEBHOOK_URL;

    if (!targetUrl) {
      this.logger.debug(
        'REN_WEBHOOK_URL not configured — skipping REN webhook',
      );

      return { success: false, statusCode: null, error: 'REN_WEBHOOK_URL not configured' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Ren-Event': 'call.booked',
    };

    const secret = process.env.REN_WEBHOOK_SECRET;

    if (secret) {
      headers['x-ren-secret'] = secret;
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(
          `REN webhook returned ${response.status} for lead ${payload.leadId} (affiliate: ${payload.affiliateId ?? 'none'}, mrr: ${payload.mrr ?? 0})`,
        );

        return { success: false, statusCode: response.status };
      }

      this.logger.log(
        `REN webhook delivered: lead ${payload.leadId}, affiliateId=${payload.affiliateId ?? 'none'}, referralId=${payload.referralId ?? 'none'}, mrr=${payload.mrr ?? 0} ${payload.mrrCurrency ?? ''}`,
      );

      return { success: true, statusCode: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `REN webhook failed for lead ${payload.leadId}: ${message}`,
      );

      return { success: false, statusCode: null, error: message };
    }
  }

  async sendStatusChanged(payload: RenStatusWebhookPayload): Promise<RenWebhookResponse> {
    const targetUrl = process.env.REN_WEBHOOK_URL;

    if (!targetUrl) {
      this.logger.debug(
        'REN_WEBHOOK_URL not configured — skipping REN status webhook',
      );

      return { success: false, statusCode: null, error: 'REN_WEBHOOK_URL not configured' };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Ren-Event': 'customer.status_changed',
    };

    const secret = process.env.REN_WEBHOOK_SECRET;

    if (secret) {
      headers['x-ren-secret'] = secret;
    }

    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10_000),
      });

      if (!response.ok) {
        this.logger.warn(
          `REN status webhook returned ${response.status} for lead ${payload.leadId} (${payload.previousStatus ?? 'none'} → ${payload.newStatus})`,
        );

        return { success: false, statusCode: response.status };
      }

      this.logger.log(
        `REN status webhook delivered: lead ${payload.leadId}, ${payload.previousStatus ?? 'none'} → ${payload.newStatus}, affiliateId=${payload.affiliateId ?? 'none'}, mrr=${payload.mrr ?? 0} ${payload.mrrCurrency ?? ''}`,
      );

      return { success: true, statusCode: response.status };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      this.logger.error(
        `REN status webhook failed for lead ${payload.leadId}: ${message}`,
      );

      return { success: false, statusCode: null, error: message };
    }
  }
}
