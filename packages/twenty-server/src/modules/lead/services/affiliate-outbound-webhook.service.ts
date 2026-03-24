import { Injectable, Logger } from '@nestjs/common';

export type AffiliateOutboundPayload = {
  event: 'lead.stage_changed';
  leadId: string;
  leadName: string;
  previousStage: string;
  newStage: string;
  workspaceId: string;
  timestamp: string;
};

@Injectable()
export class AffiliateOutboundWebhookService {
  private readonly logger = new Logger(AffiliateOutboundWebhookService.name);

  async notifyStageChange(payload: AffiliateOutboundPayload): Promise<void> {
    const targetUrl = process.env.AFFILIATE_WEBHOOK_URL;

    if (!targetUrl) {
      this.logger.debug(
        'AFFILIATE_WEBHOOK_URL not configured — skipping outbound webhook',
      );

      return;
    }

    const secret = process.env.AFFILIATE_WEBHOOK_SECRET;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (secret) {
      headers['x-webhook-secret'] = secret;
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
          `Affiliate webhook returned ${response.status} for lead ${payload.leadId}`,
        );

        return;
      }

      this.logger.log(
        `Affiliate webhook delivered: lead ${payload.leadId} stage ${payload.previousStage} → ${payload.newStage}`,
      );
    } catch (error) {
      this.logger.error(
        `Affiliate webhook failed for lead ${payload.leadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
