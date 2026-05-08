import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { LeadEventEmitterService } from 'src/modules/lead/services/lead-event-emitter.service';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

// When a lead moves to NEGOTIATION stage, auto-create a matching
// Opportunity record. When it moves away from NEGOTIATION, soft-delete
// the matching Opportunity so it disappears from the Opportunities view.
// Mirrors the LeadWonToClient / LeadLostToLoss pattern.

// Both PROPOSAL and NEGOTIATION count — whichever the user picks in the
// dropdown, an opportunity gets created / soft-deleted symmetrically.
const OPPORTUNITY_STAGE_CANDIDATES = new Set([
  'PROPOSAL',
  'NEGOTIATION',
  'Proposal',
  'Negotiation',
  'proposal',
  'negotiation',
]);

@Injectable()
export class LeadSentProposalToOpportunityListener {
  private readonly logger = new Logger(
    LeadSentProposalToOpportunityListener.name,
  );

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

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (newStage === previousStage) continue;

      const movedToOppStage =
        isDefined(newStage) && OPPORTUNITY_STAGE_CANDIDATES.has(newStage);
      const movedAwayFromOppStage =
        isDefined(previousStage) &&
        OPPORTUNITY_STAGE_CANDIDATES.has(previousStage) &&
        !movedToOppStage;

      if (!movedToOppStage && !movedAwayFromOppStage) continue;

      const lead = event.properties.after;
      const schema = getWorkspaceSchemaName(payload.workspaceId);

      // Moving away from NEGOTIATION → soft-delete the matching Opportunity.
      if (movedAwayFromOppStage) {
        try {
          const rows = await this.dataSource.query(
            `UPDATE "${schema}"."opportunity"
             SET "deletedAt" = NOW()
             WHERE name = $1 AND "deletedAt" IS NULL
             RETURNING id`,
            [lead.name],
          );

          for (const row of rows) {
            await this.eventEmitter.emitUpdated(
              'opportunity',
              row.id,
              { deletedAt: null },
              { deletedAt: new Date().toISOString() },
              payload.workspaceId,
            );
          }
          this.logger.log(
            `Soft-deleted Opportunity for lead ${event.recordId} (stage → ${newStage})`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to remove Opportunity for lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }

      // If a soft-deleted Opportunity exists for this lead, restore it
      // instead of inserting a duplicate. If a live one exists, skip.
      const existing = await this.dataSource.query(
        `SELECT id, "deletedAt" FROM "${schema}"."opportunity"
         WHERE name = $1 ORDER BY "createdAt" DESC LIMIT 1`,
        [lead.name],
      );

      // Map lead stage to opportunity stage value (uppercase canonical)
      const oppStage = (newStage ?? 'PROPOSAL').toUpperCase();

      if (existing[0]) {
        if (existing[0].deletedAt === null) {
          // Already active — sync stage so PROPOSAL ↔ NEGOTIATION transitions
          // on the lead are reflected on the opportunity.
          await this.dataSource.query(
            `UPDATE "${schema}"."opportunity"
             SET stage = $1, "updatedAt" = NOW()
             WHERE id = $2 AND stage <> $1`,
            [oppStage, existing[0].id],
          );

          await this.eventEmitter.emitUpdated(
            'opportunity',
            existing[0].id,
            {},
            { stage: oppStage },
            payload.workspaceId,
          );

          this.logger.log(
            `Updated Opportunity ${existing[0].id} stage → ${oppStage} for lead ${event.recordId}`,
          );
          continue;
        }

        await this.dataSource.query(
          `UPDATE "${schema}"."opportunity"
           SET "deletedAt" = NULL, stage = $1, "updatedAt" = NOW()
           WHERE id = $2`,
          [oppStage, existing[0].id],
        );

        await this.eventEmitter.emitUpdated(
          'opportunity',
          existing[0].id,
          { deletedAt: new Date().toISOString() },
          { deletedAt: null, stage: oppStage },
          payload.workspaceId,
        );

        this.logger.log(
          `Restored Opportunity ${existing[0].id} (stage=${oppStage}) for lead ${event.recordId}`,
        );
        continue;
      }

      // Try to resolve pointOfContactId from an existing Person (client) by email
      let pointOfContactId: string | null = null;
      const email = lead.emails?.primaryEmail;

      if (email) {
        const match = await this.dataSource.query(
          `SELECT id FROM "${schema}"."person"
           WHERE "emailsPrimaryEmail" = $1 LIMIT 1`,
          [email],
        );

        pointOfContactId = match[0]?.id ?? null;
      }

      const opportunityId = uuidv4();
      const amountCurrencyCode = lead.estimatedValue?.currencyCode ?? 'USD';
      const amountMicros = lead.estimatedValue?.amountMicros ?? null;

      try {
        // probability column was dropped from the opportunity schema even
        // though it lingers on the entity as @deprecated — skip it.
        await this.dataSource.query(
          `INSERT INTO "${schema}"."opportunity" (
            "id",
            "name",
            "amountAmountMicros", "amountCurrencyCode",
            "stage", "position",
            "pointOfContactId",
            "companyId",
            "createdAt", "updatedAt"
          ) VALUES (
            $1,
            $2,
            $3, $4,
            $7, 0,
            $5,
            $6,
            NOW(), NOW()
          )`,
          [
            opportunityId,
            lead.name,
            amountMicros,
            amountCurrencyCode,
            pointOfContactId,
            lead.companyId ?? null,
            oppStage,
          ],
        );

        // Carry over notes + tasks via junction target rows
        await this.dataSource.query(
          `UPDATE "${schema}"."noteTarget"
           SET "targetOpportunityId" = $1
           WHERE "targetLeadId" = $2 AND "targetOpportunityId" IS NULL`,
          [opportunityId, event.recordId],
        );

        await this.dataSource.query(
          `UPDATE "${schema}"."taskTarget"
           SET "targetOpportunityId" = $1
           WHERE "targetLeadId" = $2 AND "targetOpportunityId" IS NULL`,
          [opportunityId, event.recordId],
        );

        // Emit real-time CREATED event so subscribed clients pick it up
        await this.eventEmitter.emitCreated(
          'opportunity',
          opportunityId,
          {
            name: lead.name,
            stage: oppStage,
            amount: {
              amountMicros: amountMicros,
              currencyCode: amountCurrencyCode,
            },
            pointOfContactId,
            companyId: lead.companyId ?? null,
          },
          payload.workspaceId,
        );

        this.logger.log(
          `Created opportunity ${opportunityId} ("${lead.name}") from lead ${event.recordId} at stage=${oppStage}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create opportunity from lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
