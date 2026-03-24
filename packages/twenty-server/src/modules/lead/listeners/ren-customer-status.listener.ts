import { Injectable, Logger } from '@nestjs/common';

import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type RenCustomerStatus } from 'src/modules/lead/dtos/webhook.dto';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';

// Maps lead stages to customer payment statuses for the REN webhook.
//   WON  → ACTIVE   (customer is paying)
//   LOST → INACTIVE (customer stopped paying / churned)
const STAGE_TO_STATUS: Record<string, RenCustomerStatus> = {
  WON: 'ACTIVE',
  LOST: 'INACTIVE',
};

@Injectable()
export class RenCustomerStatusListener {
  private readonly logger = new Logger(RenCustomerStatusListener.name);

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

      const newStatus = STAGE_TO_STATUS[newStage];

      if (!newStatus) {
        continue;
      }

      const previousStatus = previousStage
        ? STAGE_TO_STATUS[previousStage] ?? null
        : null;

      // Skip if the payment status didn't actually change
      // (e.g. transitioning between two stages that both map to the same status)
      if (previousStatus === newStatus) {
        continue;
      }

      const lead = event.properties.after;

      const { affiliateId, referralId } = this.parseSourceDetail(
        lead.sourceDetail,
      );

      const mrr = lead.estimatedValue?.amountMicros
        ? lead.estimatedValue.amountMicros / 1_000_000
        : null;
      const mrrCurrency = lead.estimatedValue?.currencyCode ?? null;

      this.logger.log(
        `REN customer.status_changed: lead ${event.recordId}, ${previousStatus ?? 'none'} → ${newStatus}, affiliateId=${affiliateId ?? 'none'}, mrr=${mrr ?? 0}`,
      );

      await this.renWebhookService.sendStatusChanged({
        event: 'customer.status_changed',
        leadId: event.recordId,
        leadName: lead.name ?? '',
        affiliateId,
        referralId,
        previousStatus,
        newStatus,
        mrr,
        mrrCurrency,
        reason: this.inferReason(newStage, newStatus),
        workspaceId: payload.workspaceId,
        timestamp: new Date().toISOString(),
      });
    }
  }

  private inferReason(stage: string, status: RenCustomerStatus): string | null {
    if (status === 'ACTIVE') {
      return 'Deal won — customer converted to paying';
    }

    if (status === 'INACTIVE') {
      return 'Deal lost — customer churned or cancelled';
    }

    return null;
  }

  private parseSourceDetail(
    sourceDetail: string | null,
  ): { affiliateId: string | null; referralId: string | null } {
    if (!sourceDetail) {
      return { affiliateId: null, referralId: null };
    }

    try {
      const parsed = JSON.parse(sourceDetail);

      if (typeof parsed === 'object' && parsed !== null) {
        return {
          affiliateId: typeof parsed.affiliateId === 'string' ? parsed.affiliateId : null,
          referralId: typeof parsed.referralId === 'string' ? parsed.referralId : null,
        };
      }
    } catch {
      // Plain string — treat as affiliate ID
    }

    return { affiliateId: sourceDetail, referralId: null };
  }
}
