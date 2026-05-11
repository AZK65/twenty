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

// When a user changes the `stage` on a Client (Person), Loss, or Opportunity,
// route the record back to the appropriate "home" object — typically Lead.
//
// Each object has a "home" stage set:
//   Person       → WON
//   Loss         → LOST
//   Opportunity  → PROPOSAL, NEGOTIATION
//
// If the new stage isn't a home stage for THIS object, we:
//   1. Find or restore the matching Lead (by email)
//   2. Update Lead.stage to the new stage
//   3. Soft-delete the current record
// The Lead's own listeners then handle further routing automatically — e.g.,
// if the new stage is WON, LeadWonToClient restores the Person on the next pass.

type AnyRecord = Record<string, unknown> & {
  name?: string | null;
  stage?: string | null;
  emailsPrimaryEmail?: string | null;
  // person uses split name fields
  nameFirstName?: string | null;
  nameLastName?: string | null;
};

const HOME_STAGES: Record<'person' | 'loss' | 'opportunity', Set<string>> = {
  person: new Set(['WON']),
  loss: new Set(['LOST']),
  opportunity: new Set(['PROPOSAL', 'NEGOTIATION']),
};

@Injectable()
export class MirrorStageListener {
  private readonly logger = new Logger(MirrorStageListener.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: LeadEventEmitterService,
  ) {}

  @OnDatabaseBatchEvent('person', DatabaseEventAction.UPDATED)
  async handlePersonUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handle(payload, 'person');
  }

  @OnDatabaseBatchEvent('loss', DatabaseEventAction.UPDATED)
  async handleLossUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handle(payload, 'loss');
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.UPDATED)
  async handleOpportunityUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handle(payload, 'opportunity');
  }

  private async handle(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
    sourceType: 'person' | 'loss' | 'opportunity',
  ): Promise<void> {
    if (!isDefined(payload.workspaceId)) return;

    const schema = getWorkspaceSchemaName(payload.workspaceId);
    const sourceTable = sourceType === 'loss' ? '_loss' : sourceType;
    const homeStages = HOME_STAGES[sourceType];

    for (const event of payload.events) {
      const before = (event.properties.before ?? {}) as AnyRecord;
      const after = (event.properties.after ?? {}) as AnyRecord;

      const beforeStage = before.stage ?? null;
      const afterStage = after.stage ?? null;

      if (!afterStage || beforeStage === afterStage) continue;
      if (homeStages.has(afterStage)) continue;

      // Resolve identifying info for matching the lead
      const email = this.resolveEmail(sourceType, after);
      const name = this.resolveName(sourceType, after);

      if (!email && !name) {
        this.logger.warn(
          `${sourceType} ${event.recordId} → stage ${afterStage}: no email or name to find matching lead`,
        );
        continue;
      }

      try {
        const leadId = await this.findOrRestoreLead(
          schema,
          payload.workspaceId,
          email,
          name,
          afterStage,
        );

        if (!leadId) {
          this.logger.warn(
            `Could not find/restore Lead for ${sourceType} ${event.recordId} (email=${email}, name=${name})`,
          );
          continue;
        }

        // Soft-delete the source record so it disappears from its current view
        await this.dataSource.query(
          `UPDATE "${schema}"."${sourceTable}"
           SET "deletedAt" = NOW()
           WHERE id = $1 AND "deletedAt" IS NULL`,
          [event.recordId],
        );

        await this.eventEmitter.emitDeleted(
          sourceType,
          event.recordId,
          {},
          payload.workspaceId,
        );

        this.logger.log(
          `Moved ${sourceType} ${event.recordId} → Lead ${leadId} at stage ${afterStage}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to mirror ${sourceType} ${event.recordId} stage change: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private resolveEmail(
    sourceType: 'person' | 'loss' | 'opportunity',
    record: AnyRecord,
  ): string | null {
    // For opportunity, look up email via pointOfContact (Person) link
    if (sourceType === 'opportunity') {
      // The event payload may not carry the joined email — let the listener
      // fall back to lead lookup by name.
      return null;
    }

    return record.emailsPrimaryEmail?.trim().toLowerCase() || null;
  }

  private resolveName(
    sourceType: 'person' | 'loss' | 'opportunity',
    record: AnyRecord,
  ): string | null {
    if (sourceType === 'person') {
      const first = record.nameFirstName?.trim() ?? '';
      const last = record.nameLastName?.trim() ?? '';
      const composed = `${first} ${last}`.trim();

      return composed.length > 0 ? composed : null;
    }

    return record.name?.trim() || null;
  }

  // Find an existing lead (live or soft-deleted) by email or name. If found
  // and soft-deleted, restore it. If active, just update its stage. If not
  // found at all, create a minimal new lead.
  private async findOrRestoreLead(
    schema: string,
    workspaceId: string,
    email: string | null,
    name: string | null,
    stage: string,
  ): Promise<string | null> {
    // 1. Try email match
    if (email) {
      const rows = await this.dataSource.query(
        `SELECT id, stage, "deletedAt" FROM "${schema}"."lead"
         WHERE LOWER("emailsPrimaryEmail") = $1
         ORDER BY "deletedAt" NULLS FIRST, "updatedAt" DESC LIMIT 1`,
        [email],
      );

      if (rows[0]) {
        return this.activateLead(
          schema,
          workspaceId,
          rows[0].id,
          rows[0].stage,
          rows[0].deletedAt,
          stage,
        );
      }
    }

    // 2. Try name match
    if (name) {
      const rows = await this.dataSource.query(
        `SELECT id, stage, "deletedAt" FROM "${schema}"."lead"
         WHERE LOWER(name) = LOWER($1)
         ORDER BY "deletedAt" NULLS FIRST, "updatedAt" DESC LIMIT 1`,
        [name],
      );

      if (rows[0]) {
        return this.activateLead(
          schema,
          workspaceId,
          rows[0].id,
          rows[0].stage,
          rows[0].deletedAt,
          stage,
        );
      }
    }

    // 3. Create a new lead
    const newId = uuidv4();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."lead" (
         id, name, "emailsPrimaryEmail", "emailsAdditionalEmails",
         "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode",
         "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
         source, stage, priority, "enrichmentStatus", position,
         "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3, '[]'::jsonb,
         '', '', '', '[]'::jsonb,
         'MIRROR', $4, 'MEDIUM', 'NOT_ENRICHED', 0,
         NOW(), NOW()
       )`,
      [newId, name ?? '(unnamed)', email ?? '', stage],
    );

    // Emit CREATED so existing Lead-side listeners pick up the new lead
    await this.eventEmitter.emitCreated(
      'lead',
      newId,
      { name: name ?? '(unnamed)', stage, emailsPrimaryEmail: email ?? '' },
      workspaceId,
    );

    return newId;
  }

  private async activateLead(
    schema: string,
    workspaceId: string,
    leadId: string,
    previousStage: string | null,
    deletedAt: Date | null,
    stage: string,
  ): Promise<string> {
    if (deletedAt) {
      await this.dataSource.query(
        `UPDATE "${schema}"."lead"
         SET "deletedAt" = NULL, stage = $1, "updatedAt" = NOW()
         WHERE id = $2`,
        [stage, leadId],
      );

      await this.eventEmitter.emitRestored(
        'lead',
        leadId,
        { stage },
        workspaceId,
      );
    } else {
      await this.dataSource.query(
        `UPDATE "${schema}"."lead"
         SET stage = $1, "updatedAt" = NOW()
         WHERE id = $2`,
        [stage, leadId],
      );
    }

    // Emit synthetic UPDATED so Lead-side listeners (WonToClient, LostToLoss,
    // SentProposalToOpportunity, HideOnFinalStage) react to the stage change.
    if (previousStage !== stage) {
      await this.eventEmitter.emitUpdated(
        'lead',
        leadId,
        { stage: previousStage ?? null },
        { stage },
        workspaceId,
      );
    }

    return leadId;
  }
}
