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

// When a lead is marked as WON, automatically create a Person (Client) record
// with the lead's contact information so they appear in the Clients list.

@Injectable()
export class LeadWonToClientListener {
  private readonly logger = new Logger(LeadWonToClientListener.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: LeadEventEmitterService,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<LeadWorkspaceEntity>>,
  ) {
    if (!isDefined(payload.workspaceId)) {
      return;
    }

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (
        !isDefined(newStage) ||
        newStage !== 'WON' ||
        newStage === previousStage
      ) {
        continue;
      }

      const lead = event.properties.after;
      const schema = getWorkspaceSchemaName(payload.workspaceId);

      // If a Person already exists with this email, surface it as a "fresh"
      // client by bumping updatedAt and restoring it if soft-deleted. Without
      // this bump, the Clients view (sorted by recency) wouldn't reflect the
      // new WON transition because the existing Person was created earlier.
      const email = lead.emails?.primaryEmail;

      if (email) {
        const existing = await this.dataSource.query(
          `SELECT id, "deletedAt" FROM "${schema}"."person"
           WHERE "emailsPrimaryEmail" = $1 LIMIT 1`,
          [email],
        );

        if (existing.length > 0) {
          const personId = existing[0].id;
          const wasDeleted = existing[0].deletedAt !== null;

          await this.dataSource.query(
            `UPDATE "${schema}"."person"
             SET "deletedAt" = NULL, "updatedAt" = NOW()
             WHERE id = $1`,
            [personId],
          );

          // Re-link any lead notes/tasks that aren't yet pointed at this Person
          await this.dataSource.query(
            `UPDATE "${schema}"."noteTarget" SET "targetPersonId" = $1
             WHERE "targetLeadId" = $2 AND "targetPersonId" IS NULL`,
            [personId, event.recordId],
          );
          await this.dataSource.query(
            `UPDATE "${schema}"."taskTarget" SET "targetPersonId" = $1
             WHERE "targetLeadId" = $2 AND "targetPersonId" IS NULL`,
            [personId, event.recordId],
          );

          if (wasDeleted) {
            await this.eventEmitter.emitRestored(
              'person',
              personId,
              { emailsPrimaryEmail: email },
              payload.workspaceId,
            );
            this.logger.log(
              `Restored soft-deleted Client ${personId} (email: ${email}) for won lead ${event.recordId}`,
            );
          } else {
            await this.eventEmitter.emitUpdated(
              'person',
              personId,
              {},
              { updatedAt: new Date().toISOString() },
              payload.workspaceId,
            );
            this.logger.log(
              `Bumped existing Client ${personId} (email: ${email}) on WON lead ${event.recordId}`,
            );
          }

          continue;
        }
      }

      // Parse name into first/last
      const nameParts = (lead.name ?? '').trim().split(' ');
      const firstName = nameParts[0] ?? '';
      const lastName = nameParts.slice(1).join(' ') ?? '';

      const personId = uuidv4();

      try {
        await this.dataSource.query(
          `INSERT INTO "${schema}"."person" (
            "id",
            "nameFirstName", "nameLastName",
            "emailsPrimaryEmail", "emailsAdditionalEmails",
            "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
            "linkedinLinkPrimaryLinkLabel", "linkedinLinkPrimaryLinkUrl", "linkedinLinkSecondaryLinks",
            "jobTitle", "city",
            "position",
            "createdAt", "updatedAt"
          ) VALUES (
            $1,
            $2, $3,
            $4, '[]'::jsonb,
            $5, $6, '', '[]'::jsonb,
            $7, $8, '[]'::jsonb,
            '', '',
            0,
            NOW(), NOW()
          )`,
          [
            personId,
            firstName,
            lastName,
            email ?? '',
            lead.phones?.primaryPhoneNumber ?? '',
            lead.phones?.primaryPhoneCountryCode ?? '',
            lead.linkedinLink?.primaryLinkLabel ?? '',
            lead.linkedinLink?.primaryLinkUrl ?? '',
          ],
        );

        // Link existing lead notes to the new person
        await this.dataSource.query(
          `UPDATE "${schema}"."noteTarget" SET "targetPersonId" = $1 WHERE "targetLeadId" = $2 AND "targetPersonId" IS NULL`,
          [personId, event.recordId],
        );

        // Link existing lead tasks to the new person
        await this.dataSource.query(
          `UPDATE "${schema}"."taskTarget" SET "targetPersonId" = $1 WHERE "targetLeadId" = $2 AND "targetPersonId" IS NULL`,
          [personId, event.recordId],
        );

        this.logger.log(
          `Created client ${personId} (${firstName} ${lastName}) from won lead ${event.recordId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create client from lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
