import { Injectable, Logger } from '@nestjs/common';

import { ObjectRecordCreateEvent } from 'twenty-shared/database-events';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';

// Emits database events for leads created via raw SQL,
// so that the real-time subscription system picks them up.

@Injectable()
export class LeadEventEmitterService {
  private readonly logger = new Logger(LeadEventEmitterService.name);

  constructor(
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async emitLeadCreated(
    leadId: string,
    leadData: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    try {
      const { flatObjectMetadataMaps } =
        await this.workspaceCacheService.getOrRecompute(workspaceId, [
          'flatObjectMetadataMaps',
        ]);

      // Find the lead object metadata
      const leadMetadata = Object.values(
        flatObjectMetadataMaps.byUniversalIdentifier,
      ).find(
        (meta) => meta && 'nameSingular' in meta && meta.nameSingular === 'lead',
      );

      if (!leadMetadata) {
        this.logger.warn('Lead object metadata not found in cache');

        return;
      }

      const event = new ObjectRecordCreateEvent();

      event.recordId = leadId;
      event.properties = {
        after: { id: leadId, ...leadData },
      };

      this.workspaceEventEmitter.emitDatabaseBatchEvent({
        objectMetadataNameSingular: 'lead',
        action: DatabaseEventAction.CREATED,
        events: [event],
        objectMetadata: leadMetadata as never,
        workspaceId,
      });

      this.logger.log(`Emitted CREATED event for lead ${leadId}`);
    } catch (error) {
      this.logger.warn(
        `Failed to emit lead event: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
