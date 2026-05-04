import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { LeadEventEmitterService } from 'src/modules/lead/services/lead-event-emitter.service';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

// Hide the Lead from the Leads list when it transitions to a "final" stage:
//   WON        → Client (Person) takes over
//   LOST       → Loss takes over
//   PROPOSAL   → Opportunity takes over
//   NEGOTIATION → Opportunity takes over
//
// If the user moves the lead BACK to any non-final stage, restore the lead
// (clear deletedAt) so it reappears in the Leads list.
//
// We use raw SQL to avoid triggering the lead update event recursively.

const HIDE_STAGES = new Set([
  'WON',
  'Won',
  'won',
  'LOST',
  'Lost',
  'lost',
  'PROPOSAL',
  'Proposal',
  'proposal',
  'NEGOTIATION',
  'Negotiation',
  'negotiation',
]);

@Injectable()
export class LeadHideOnFinalStageListener {
  private readonly logger = new Logger(LeadHideOnFinalStageListener.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: LeadEventEmitterService,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<LeadWorkspaceEntity>>,
  ) {
    if (!isDefined(payload.workspaceId)) return;

    const schema = getWorkspaceSchemaName(payload.workspaceId);

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (newStage === previousStage) continue;

      const movedToHideStage = isDefined(newStage) && HIDE_STAGES.has(newStage);
      const movedAwayFromHideStage =
        isDefined(previousStage) &&
        HIDE_STAGES.has(previousStage) &&
        !movedToHideStage;

      if (!movedToHideStage && !movedAwayFromHideStage) continue;

      try {
        if (movedToHideStage) {
          const result = await this.dataSource.query(
            `UPDATE "${schema}"."lead"
             SET "deletedAt" = NOW()
             WHERE id = $1 AND "deletedAt" IS NULL
             RETURNING id`,
            [event.recordId],
          );

          if (result.length > 0) {
            await this.eventEmitter.emitUpdated(
              'lead',
              event.recordId,
              { deletedAt: null },
              { deletedAt: new Date().toISOString() },
              payload.workspaceId,
            );
            this.logger.log(
              `Hid lead ${event.recordId} from Leads list (stage → ${newStage})`,
            );
          }
        } else {
          const result = await this.dataSource.query(
            `UPDATE "${schema}"."lead"
             SET "deletedAt" = NULL
             WHERE id = $1 AND "deletedAt" IS NOT NULL
             RETURNING id`,
            [event.recordId],
          );

          if (result.length > 0) {
            await this.eventEmitter.emitUpdated(
              'lead',
              event.recordId,
              { deletedAt: new Date().toISOString() },
              { deletedAt: null },
              payload.workspaceId,
            );
            this.logger.log(
              `Restored lead ${event.recordId} to Leads list (stage → ${newStage})`,
            );
          }
        }
      } catch (error) {
        this.logger.warn(
          `Failed to toggle lead visibility for ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
