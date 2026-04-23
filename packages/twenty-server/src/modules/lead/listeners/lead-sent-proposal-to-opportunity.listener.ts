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
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

// When a lead moves to NEGOTIATION stage, auto-create a matching
// Opportunity record. When it moves away from NEGOTIATION, soft-delete
// the matching Opportunity so it disappears from the Opportunities view.
// Mirrors the LeadWonToClient / LeadLostToLoss pattern.

const NEGOTIATION_STAGE_CANDIDATES = new Set([
  'NEGOTIATION',
  'Negotiation',
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
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadUpdated(
    payload: WorkspaceEventBatch<
      ObjectRecordUpdateEvent<LeadWorkspaceEntity>
    >,
  ) {
    if (!isDefined(payload.workspaceId)) return;

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (newStage === previousStage) continue;

      const movedToNegotiation =
        isDefined(newStage) && NEGOTIATION_STAGE_CANDIDATES.has(newStage);
      const movedAwayFromNegotiation =
        isDefined(previousStage) &&
        NEGOTIATION_STAGE_CANDIDATES.has(previousStage) &&
        !movedToNegotiation;

      if (!movedToNegotiation && !movedAwayFromNegotiation) continue;

      const lead = event.properties.after;
      const schema = getWorkspaceSchemaName(payload.workspaceId);

      // Moving away from NEGOTIATION → soft-delete the matching Opportunity.
      if (movedAwayFromNegotiation) {
        try {
          await this.dataSource.query(
            `UPDATE "${schema}"."opportunity"
             SET "deletedAt" = NOW()
             WHERE name = $1 AND "deletedAt" IS NULL`,
            [lead.name],
          );
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

      // Dedupe: skip if an opportunity with the same name already references
      // this lead via a noteTarget/taskTarget (best-effort — Twenty's opp
      // table doesn't hold a leadId foreign key).
      const existing = await this.dataSource.query(
        `SELECT id FROM "${schema}"."opportunity"
         WHERE name = $1 LIMIT 1`,
        [lead.name],
      );

      if (existing.length > 0) {
        this.logger.log(
          `Opportunity already exists for lead ${event.recordId} ("${lead.name}"), skipping`,
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
      const amountCurrencyCode =
        lead.estimatedValue?.currencyCode ?? 'USD';
      const amountMicros =
        lead.estimatedValue?.amountMicros ?? null;

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
            'PROPOSAL', 0,
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

        this.logger.log(
          `Created opportunity ${opportunityId} ("${lead.name}") from lead ${event.recordId} at stage=SENT_PROPOSAL`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create opportunity from lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
