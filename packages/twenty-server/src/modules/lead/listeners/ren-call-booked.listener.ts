import { Injectable, Logger } from '@nestjs/common';

import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';

// REN listener: fires the REN outbound webhook when a customer call is booked.
// Triggers when a lead transitions to MEETING_SCHEDULED or PRE_CALL.
// Extracts affiliateId/referralId from sourceDetail and MRR from estimatedValue.

const CALL_BOOKED_STAGES = new Set(['MEETING_SCHEDULED', 'PRE_CALL']);

@Injectable()
export class RenCallBookedListener {
  private readonly logger = new Logger(RenCallBookedListener.name);

  constructor(
    private readonly renWebhookService: RenWebhookService,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadUpdated(
    payload: WorkspaceEventBatch<
      ObjectRecordUpdateEvent<LeadWorkspaceEntity>
    >,
  ) {
    if (!isDefined(payload.workspaceId)) {
      return;
    }

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (!isDefined(newStage) || newStage === previousStage) {
        continue;
      }

      if (!CALL_BOOKED_STAGES.has(newStage)) {
        continue;
      }

      const lead = event.properties.after;

      // Extract affiliateId and referralId from sourceDetail.
      // sourceDetail stores the affiliate/referral identifier set during
      // lead creation via the affiliate webhook.
      const { affiliateId, referralId } = this.parseSourceDetail(
        lead.sourceDetail,
      );

      // Extract MRR from estimatedValue (CurrencyMetadata)
      const mrr = lead.estimatedValue?.amountMicros
        ? lead.estimatedValue.amountMicros / 1_000_000
        : null;
      const mrrCurrency = lead.estimatedValue?.currencyCode ?? null;

      this.logger.log(
        `REN call.booked: lead ${event.recordId}, stage → ${newStage}, affiliateId=${affiliateId ?? 'none'}, referralId=${referralId ?? 'none'}, mrr=${mrr ?? 0}`,
      );

      await this.renWebhookService.sendCallBooked({
        event: 'call.booked',
        leadId: event.recordId,
        leadName: lead.name ?? '',
        affiliateId,
        referralId,
        mrr,
        mrrCurrency,
        callBookedAt: new Date().toISOString(),
        workspaceId: payload.workspaceId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  // sourceDetail can be a plain affiliate ID string, or a JSON string like:
  //   "aff_123"
  //   '{"affiliateId":"aff_123","referralId":"ref_456"}'
  private parseSourceDetail(
    sourceDetail: string | null,
  ): { affiliateId: string | null; referralId: string | null } {
    if (!sourceDetail) {
      return { affiliateId: null, referralId: null };
    }

    // Try parsing as JSON first
    try {
      const parsed = JSON.parse(sourceDetail);

      if (typeof parsed === 'object' && parsed !== null) {
        return {
          affiliateId: typeof parsed.affiliateId === 'string' ? parsed.affiliateId : null,
          referralId: typeof parsed.referralId === 'string' ? parsed.referralId : null,
        };
      }
    } catch {
      // Not JSON — treat as plain affiliate ID string
    }

    return { affiliateId: sourceDetail, referralId: null };
  }
}
