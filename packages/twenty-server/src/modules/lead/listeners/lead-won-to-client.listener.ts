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

// When a lead is marked as WON, automatically create a Person (Client) record
// with the lead's contact information so they appear in the Clients list.

@Injectable()
export class LeadWonToClientListener {
  private readonly logger = new Logger(LeadWonToClientListener.name);

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
    if (!isDefined(payload.workspaceId)) {
      return;
    }

    for (const event of payload.events) {
      const previousStage = event.properties.before.stage;
      const newStage = event.properties.after.stage;

      if (!isDefined(newStage) || newStage !== 'WON' || newStage === previousStage) {
        continue;
      }

      const lead = event.properties.after;
      const schema = getWorkspaceSchemaName(payload.workspaceId);

      // Check if a person with this email already exists
      const email = lead.emails?.primaryEmail;

      if (email) {
        const existing = await this.dataSource.query(
          `SELECT id FROM "${schema}"."person" WHERE "emailsPrimaryEmail" = $1 LIMIT 1`,
          [email],
        );

        if (existing.length > 0) {
          this.logger.log(
            `Client already exists for lead ${event.recordId} (email: ${email}), skipping`,
          );

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
