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
  // opportunity links to person via pointOfContactId
  pointOfContactId?: string | null;
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

    this.logger.log(
      `MirrorStage received ${sourceType}.updated batch (${payload.events.length} event${payload.events.length === 1 ? '' : 's'})`,
    );

    for (const event of payload.events) {
      const before = (event.properties.before ?? {}) as AnyRecord;
      const after = (event.properties.after ?? {}) as AnyRecord;

      const beforeStage = before.stage ?? null;
      const afterStage = after.stage ?? null;

      this.logger.log(
        `MirrorStage ${sourceType} ${event.recordId} stage ${beforeStage ?? '(none)'} → ${afterStage ?? '(none)'} (homeStages=${[...homeStages].join(',')})`,
      );

      if (!afterStage || beforeStage === afterStage) {
        this.logger.log(
          `MirrorStage ${sourceType} ${event.recordId} skip: no change`,
        );
        continue;
      }
      if (homeStages.has(afterStage)) {
        this.logger.log(
          `MirrorStage ${sourceType} ${event.recordId} skip: ${afterStage} is a home stage`,
        );
        continue;
      }

      // Resolve identifying info for matching the lead
      const email = await this.resolveEmail(schema, sourceType, after);
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

        // Carry notes/tasks over to the Lead before soft-deleting the source.
        // Otherwise the existing notes (attached via targetPersonId /
        // targetLossId / targetOpportunityId) get stranded on the
        // soft-deleted record, and the downstream Lead-side listener
        // (LeadWonToClient etc.) only re-links notes by `targetLeadId`.
        const targetCol =
          sourceType === 'person'
            ? 'targetPersonId'
            : sourceType === 'loss'
              ? 'targetLossId'
              : 'targetOpportunityId';

        await this.dataSource.query(
          `UPDATE "${schema}"."noteTarget"
           SET "targetLeadId" = $1
           WHERE "${targetCol}" = $2 AND "targetLeadId" IS NULL`,
          [leadId, event.recordId],
        );
        await this.dataSource.query(
          `UPDATE "${schema}"."taskTarget"
           SET "targetLeadId" = $1
           WHERE "${targetCol}" = $2 AND "targetLeadId" IS NULL`,
          [leadId, event.recordId],
        );

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

  private async resolveEmail(
    schema: string,
    sourceType: 'person' | 'loss' | 'opportunity',
    record: AnyRecord,
  ): Promise<string | null> {
    // For opportunity, fetch the email from the linked pointOfContact Person
    if (sourceType === 'opportunity') {
      if (!record.pointOfContactId) return null;

      try {
        const rows = await this.dataSource.query(
          `SELECT "emailsPrimaryEmail" AS email FROM "${schema}"."person"
           WHERE id = $1 LIMIT 1`,
          [record.pointOfContactId],
        );

        return rows[0]?.email?.trim().toLowerCase() || null;
      } catch {
        return null;
      }
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
         'OTHER', $4, 'MEDIUM', 'NOT_ENRICHED', 0,
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
      // Fetch the lead row so downstream listeners receive a FULL payload —
      // name/emails/phones/companyId etc. Without this, LeadWonToClient sees
      // an empty `after.emails.primaryEmail` and can't dedup or populate the
      // new Person, leaving the user with an orphaned soft-deleted lead.
      const after = await this.fetchLeadForEvent(schema, leadId, stage);

      await this.eventEmitter.emitUpdated(
        'lead',
        leadId,
        { stage: previousStage ?? null },
        after,
        workspaceId,
      );
    }

    return leadId;
  }

  private async fetchLeadForEvent(
    schema: string,
    leadId: string,
    fallbackStage: string,
  ): Promise<Record<string, unknown>> {
    try {
      const rows = await this.dataSource.query(
        `SELECT
           id, name, stage::text AS stage,
           "emailsPrimaryEmail",
           "emailsAdditionalEmails",
           "phonesPrimaryPhoneNumber",
           "phonesPrimaryPhoneCountryCode",
           "phonesPrimaryPhoneCallingCode",
           "phonesAdditionalPhones",
           "linkedinLinkPrimaryLinkLabel",
           "linkedinLinkPrimaryLinkUrl",
           "linkedinLinkSecondaryLinks",
           "companyId", source, "sourceDetail", needs
         FROM "${schema}"."lead" WHERE id = $1 LIMIT 1`,
        [leadId],
      );

      if (!rows[0]) return { stage: fallbackStage };

      const r = rows[0];

      // Shape the payload to match Twenty's composite field structure that
      // LeadWonToClient expects (lead.emails.primaryEmail, lead.phones.*).
      return {
        id: r.id,
        name: r.name,
        stage: r.stage,
        companyId: r.companyId,
        source: r.source,
        sourceDetail: r.sourceDetail,
        needs: r.needs,
        emails: {
          primaryEmail: r.emailsPrimaryEmail ?? '',
          additionalEmails: r.emailsAdditionalEmails ?? [],
        },
        phones: {
          primaryPhoneNumber: r.phonesPrimaryPhoneNumber ?? '',
          primaryPhoneCountryCode: r.phonesPrimaryPhoneCountryCode ?? '',
          primaryPhoneCallingCode: r.phonesPrimaryPhoneCallingCode ?? '',
          additionalPhones: r.phonesAdditionalPhones ?? [],
        },
        linkedinLink: {
          primaryLinkLabel: r.linkedinLinkPrimaryLinkLabel ?? '',
          primaryLinkUrl: r.linkedinLinkPrimaryLinkUrl ?? '',
          secondaryLinks: r.linkedinLinkSecondaryLinks ?? [],
        },
      };
    } catch {
      return { stage: fallbackStage };
    }
  }
}
