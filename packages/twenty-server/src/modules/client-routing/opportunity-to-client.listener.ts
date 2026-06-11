import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import {
  type ObjectRecordCreateEvent,
  type ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type OpportunityWorkspaceEntity } from 'src/modules/opportunity/standard-objects/opportunity.workspace-entity';

type OpportunityRow = {
  name: string | null;
  stage: string | null;
  emailPrimaryEmail: string | null;
  telegram: string | null;
  pointOfContactId: string | null;
  appticsCrm: string[] | null;
  appticsPayments: string[] | null;
  companyRevenueAmountMicros: string | null;
  companyRevenueCurrencyCode: string | null;
};

// When an opportunity is won, carry its Apptics CRM / Apptics Payments values
// onto the linked client (person), so the client lands in the right filtered
// view (Checkout Clients = Apptics CRM "Yes"; Payments Clients = Apptics
// Payments "Yes"). If no client is linked, one is created from the opportunity.
@Injectable()
export class OpportunityToClientListener {
  private readonly logger = new Logger(OpportunityToClientListener.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.UPDATED)
  async handleUpdated(
    payload: WorkspaceEventBatch<
      ObjectRecordUpdateEvent<OpportunityWorkspaceEntity>
    >,
  ): Promise<void> {
    await this.handle(payload.workspaceId, payload.events);
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.CREATED)
  async handleCreated(
    payload: WorkspaceEventBatch<
      ObjectRecordCreateEvent<OpportunityWorkspaceEntity>
    >,
  ): Promise<void> {
    await this.handle(payload.workspaceId, payload.events);
  }

  private async handle(
    workspaceId: string | undefined,
    events: { recordId: string }[],
  ): Promise<void> {
    if (!isDefined(workspaceId)) {
      return;
    }

    for (const event of events) {
      try {
        await this.routeOpportunity(workspaceId, event.recordId);
      } catch (error) {
        this.logger.error(
          `Failed to route won opportunity ${event.recordId} to a client: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async routeOpportunity(
    workspaceId: string,
    opportunityId: string,
  ): Promise<void> {
    const schema = getWorkspaceSchemaName(workspaceId);

    const [opportunity]: OpportunityRow[] = await this.dataSource.query(
      `SELECT name, stage, "emailPrimaryEmail", telegram, "pointOfContactId",
              "appticsCrm"::text[] AS "appticsCrm",
              "appticsPayments"::text[] AS "appticsPayments",
              "companyRevenueAmountMicros", "companyRevenueCurrencyCode"
         FROM "${schema}"."opportunity"
        WHERE id = $1 AND "deletedAt" IS NULL
        LIMIT 1`,
      [opportunityId],
    );

    if (
      !isDefined(opportunity) ||
      !isDefined(opportunity.stage) ||
      !opportunity.stage.toLowerCase().includes('won')
    ) {
      return;
    }

    const crm = opportunity.appticsCrm ?? [];
    const payments = opportunity.appticsPayments ?? [];

    // Find the client: linked point of contact, else by email.
    let personId = opportunity.pointOfContactId;

    if (!isDefined(personId) && isDefined(opportunity.emailPrimaryEmail)) {
      const [match]: { id: string }[] = await this.dataSource.query(
        `SELECT id FROM "${schema}"."person"
          WHERE "emailsPrimaryEmail" = $1 AND "deletedAt" IS NULL
          LIMIT 1`,
        [opportunity.emailPrimaryEmail],
      );
      personId = match?.id ?? null;
    }

    if (isDefined(personId)) {
      await this.dataSource.query(
        `UPDATE "${schema}"."person"
            SET "appticsCrm" = $2::text[]::"${schema}"."person_appticsCrm_enum"[],
                "appticsPayments" = $3::text[]::"${schema}"."person_appticsPayments_enum"[],
                "updatedAt" = now()
          WHERE id = $1`,
        [personId, crm, payments],
      );

      this.logger.log(
        `Routed won opportunity ${opportunityId} to existing client ${personId}`,
      );

      return;
    }

    // No linked client: create one from the opportunity.
    const nameParts = (opportunity.name ?? '').trim().split(' ');
    const newId = uuidv4();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."person" (
         id, "nameFirstName", "nameLastName",
         "emailsPrimaryEmail", "emailsAdditionalEmails",
         telegram,
         "appticsCrm", "appticsPayments",
         "companyRevenueAmountMicros", "companyRevenueCurrencyCode",
         position, "createdAt", "updatedAt"
       ) VALUES (
         $1, $2, $3,
         $4, '[]'::jsonb,
         $5,
         $6::text[]::"${schema}"."person_appticsCrm_enum"[],
         $7::text[]::"${schema}"."person_appticsPayments_enum"[],
         $8, $9,
         0, NOW(), NOW()
       )`,
      [
        newId,
        nameParts[0] ?? '(unnamed)',
        nameParts.slice(1).join(' '),
        opportunity.emailPrimaryEmail ?? '',
        opportunity.telegram ?? '',
        crm,
        payments,
        opportunity.companyRevenueAmountMicros,
        opportunity.companyRevenueCurrencyCode,
      ],
    );

    this.logger.log(
      `Created client ${newId} from won opportunity ${opportunityId}`,
    );
  }
}
