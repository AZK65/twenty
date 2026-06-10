import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import {
  type ObjectRecordCreateEvent,
  type ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import { type OpportunityWorkspaceEntity } from 'src/modules/opportunity/standard-objects/opportunity.workspace-entity';

type OpportunitySnapshotRow = {
  name: string | null;
  stage: string | null;
  appticsCrm: string[] | null;
  companyRevenueAmountMicros: string | null;
  companyRevenueCurrencyCode: string | null;
  ownerId: string | null;
};

// Feeds the Sales Deals payout sheet from the Opportunity object.
// - When an opportunity becomes won-like, a sales_deal row is created
//   (deduped on sourceOpportunityId via a unique constraint).
// - On every opportunity edit, the transferred columns are re-synced.
// Money + notes + the manual brand/leadSource fields are never touched here.
@Injectable()
export class SalesDealSyncListener {
  private readonly logger = new Logger(SalesDealSyncListener.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.UPDATED)
  async handleOpportunityUpdated(
    payload: WorkspaceEventBatch<
      ObjectRecordUpdateEvent<OpportunityWorkspaceEntity>
    >,
  ): Promise<void> {
    await this.handle(payload.workspaceId, payload.events);
  }

  @OnDatabaseBatchEvent('opportunity', DatabaseEventAction.CREATED)
  async handleOpportunityCreated(
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
        await this.syncFromOpportunity(workspaceId, event.recordId);
      } catch (error) {
        this.logger.error(
          `Failed to sync sales deal for opportunity ${event.recordId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private async syncFromOpportunity(
    workspaceId: string,
    opportunityId: string,
  ): Promise<void> {
    const schema = getWorkspaceSchemaName(workspaceId);

    const opportunityRows: OpportunitySnapshotRow[] =
      await this.dataSource.query(
        `SELECT name, stage, "appticsCrm",
                "companyRevenueAmountMicros", "companyRevenueCurrencyCode",
                "ownerId"
           FROM "${schema}"."opportunity"
          WHERE id = $1 AND "deletedAt" IS NULL
          LIMIT 1`,
        [opportunityId],
      );

    const opportunity = opportunityRows[0];

    if (!isDefined(opportunity)) {
      return;
    }

    const salesRep = await this.resolveOwnerName(schema, opportunity.ownerId);

    const snapshot = {
      name: opportunity.name ?? '',
      companyRevenue: this.formatRevenue(
        opportunity.companyRevenueAmountMicros,
        opportunity.companyRevenueCurrencyCode,
      ),
      appticsCrm: (opportunity.appticsCrm ?? []).join(', '),
      stage: opportunity.stage ?? '',
      salesRep,
    };

    const existing: { id: string }[] = await this.dataSource.query(
      `SELECT id FROM core.sales_deal
        WHERE "workspaceId" = $1 AND "sourceOpportunityId" = $2
        LIMIT 1`,
      [workspaceId, opportunityId],
    );

    if (existing.length > 0) {
      await this.dataSource.query(
        `UPDATE core.sales_deal
            SET name = $3,
                "companyRevenue" = $4,
                "appticsCrm" = $5,
                stage = $6,
                "salesRep" = $7,
                "updatedAt" = now()
          WHERE "workspaceId" = $1 AND "sourceOpportunityId" = $2`,
        [
          workspaceId,
          opportunityId,
          snapshot.name,
          snapshot.companyRevenue,
          snapshot.appticsCrm,
          snapshot.stage,
          snapshot.salesRep,
        ],
      );

      return;
    }

    if (!this.isWonLike(opportunity.stage)) {
      return;
    }

    const positionRows: { nextPosition: number }[] =
      await this.dataSource.query(
        `SELECT COALESCE(MAX(position), -1) + 1 AS "nextPosition"
           FROM core.sales_deal
          WHERE "workspaceId" = $1`,
        [workspaceId],
      );
    const nextPosition = positionRows[0]?.nextPosition ?? 0;

    // Unique (workspaceId, sourceOpportunityId) makes re-wins a no-op.
    await this.dataSource.query(
      `INSERT INTO core.sales_deal
         ("workspaceId", "sourceOpportunityId", position,
          name, "companyRevenue", "appticsCrm", stage, "salesRep")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT ("workspaceId", "sourceOpportunityId") DO NOTHING`,
      [
        workspaceId,
        opportunityId,
        nextPosition,
        snapshot.name,
        snapshot.companyRevenue,
        snapshot.appticsCrm,
        snapshot.stage,
        snapshot.salesRep,
      ],
    );

    this.logger.log(
      `Created sales deal for won opportunity ${opportunityId} (${snapshot.name})`,
    );
  }

  private async resolveOwnerName(
    schema: string,
    ownerId: string | null,
  ): Promise<string> {
    if (!isDefined(ownerId)) {
      return '';
    }

    const rows: {
      nameFirstName: string | null;
      nameLastName: string | null;
    }[] = await this.dataSource.query(
      `SELECT "nameFirstName", "nameLastName"
           FROM "${schema}"."workspaceMember"
          WHERE id = $1 LIMIT 1`,
      [ownerId],
    );

    const member = rows[0];

    if (!isDefined(member)) {
      return '';
    }

    return [member.nameFirstName, member.nameLastName]
      .filter((part) => isDefined(part) && part !== '')
      .join(' ');
  }

  private formatRevenue(
    amountMicros: string | null,
    currencyCode: string | null,
  ): string {
    if (!isDefined(amountMicros)) {
      return '';
    }

    const amount = Number(amountMicros) / 1_000_000;

    if (Number.isNaN(amount)) {
      return '';
    }

    return `${currencyCode ?? 'USD'} ${amount.toLocaleString('en-US')}`;
  }

  private isWonLike(stage: string | null): boolean {
    return isDefined(stage) && stage.toLowerCase().includes('won');
  }
}
