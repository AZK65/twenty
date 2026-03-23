import { Injectable, Logger } from '@nestjs/common';

import {
  type ObjectRecordCreateEvent,
  type ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { LeadEnrichmentService } from 'src/modules/lead/services/lead-enrichment.service';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

@Injectable()
export class LeadEnrichmentListener {
  private readonly logger = new Logger(LeadEnrichmentListener.name);

  constructor(
    private readonly leadEnrichmentService: LeadEnrichmentService,
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.CREATED)
  async handleLeadCreated(
    payload: WorkspaceEventBatch<
      ObjectRecordCreateEvent<LeadWorkspaceEntity>
    >,
  ) {
    if (!isDefined(payload.workspaceId)) {
      return;
    }

    for (const event of payload.events) {
      const primaryEmail = event.properties.after.emails?.primaryEmail;

      if (!isDefined(primaryEmail) || primaryEmail.trim() === '') {
        this.logger.log(
          `Lead ${event.recordId} created without email, skipping enrichment`,
        );

        continue;
      }

      this.logger.log(
        `Lead ${event.recordId} created with email, triggering enrichment`,
      );

      await this.setEnrichmentStatus(
        event.recordId,
        payload.workspaceId,
        'PENDING',
      );

      // Fire and forget - enrichment runs asynchronously
      void this.leadEnrichmentService.enrichLead(
        event.recordId,
        payload.workspaceId,
      );
    }
  }

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
      const beforeEmail = event.properties.before.emails?.primaryEmail;
      const afterEmail = event.properties.after.emails?.primaryEmail;

      // Only trigger enrichment if the email actually changed
      if (!isDefined(afterEmail) || afterEmail === beforeEmail) {
        continue;
      }

      if (afterEmail.trim() === '') {
        continue;
      }

      this.logger.log(
        `Lead ${event.recordId} email changed, triggering enrichment`,
      );

      await this.setEnrichmentStatus(
        event.recordId,
        payload.workspaceId,
        'PENDING',
      );

      // Fire and forget - enrichment runs asynchronously
      void this.leadEnrichmentService.enrichLead(
        event.recordId,
        payload.workspaceId,
      );
    }
  }

  private async setEnrichmentStatus(
    leadId: string,
    workspaceId: string,
    status: string,
  ): Promise<void> {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(async () => {
      const leadRepository =
        await this.globalWorkspaceOrmManager.getRepository<LeadWorkspaceEntity>(
          workspaceId,
          'lead',
          { shouldBypassPermissionChecks: true },
        );

      await leadRepository.update({ id: leadId }, { enrichmentStatus: status });
    }, authContext);
  }
}
