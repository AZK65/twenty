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

// When a lead moves to LOST stage, auto-create a matching Loss row.
// Copy fields defensively — the "loss" table is a custom object the user
// defined in the UI; its column set may be smaller than Lead's. We attempt
// to insert a minimal set of name/emails/phones. If more fields are needed,
// extend the column list after adding the field via Settings -> Data Model.

const LOST_STAGE_CANDIDATES = new Set([
  'LOST',
  'Lost',
  'lost',
]);

@Injectable()
export class LeadLostToLossListener {
  private readonly logger = new Logger(LeadLostToLossListener.name);

  // Lazily computed set of existing columns on the "loss" table so we
  // only attempt to write columns that actually exist.
  private lossColumnsByWorkspace = new Map<string, Set<string>>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: LeadEventEmitterService,
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

      const movedToLost =
        isDefined(newStage) && LOST_STAGE_CANDIDATES.has(newStage);
      const movedAwayFromLost =
        isDefined(previousStage) &&
        LOST_STAGE_CANDIDATES.has(previousStage) &&
        !movedToLost;

      if (!movedToLost && !movedAwayFromLost) continue;

      const lead = event.properties.after;
      const schema = getWorkspaceSchemaName(payload.workspaceId);

      // Moving away from LOST → soft-delete the matching Loss row.
      if (movedAwayFromLost) {
        try {
          const rows = await this.dataSource.query(
            `UPDATE "${schema}"."_loss"
             SET "deletedAt" = NOW()
             WHERE name = $1 AND "deletedAt" IS NULL
             RETURNING id`,
            [lead.name],
          );

          for (const row of rows) {
            await this.eventEmitter.emitUpdated(
              'loss',
              row.id,
              { deletedAt: null },
              { deletedAt: new Date().toISOString() },
              payload.workspaceId,
            );
          }
          this.logger.log(
            `Soft-deleted Loss row for lead ${event.recordId} (stage → ${newStage})`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to remove Loss for lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        continue;
      }

      try {
        const columns = await this.getLossColumns(schema);

        if (columns.size === 0) {
          this.logger.warn(
            `No "loss" table in ${schema} — create the Loss object in Settings → Data Model first`,
          );
          continue;
        }

        // Dedupe by name — best-effort.
        const existing = await this.dataSource.query(
          `SELECT id FROM "${schema}"."_loss" WHERE name = $1 LIMIT 1`,
          [lead.name],
        );

        if (existing.length > 0) {
          this.logger.log(
            `Loss already exists for lead ${event.recordId} ("${lead.name}")`,
          );
          continue;
        }

        const lossId = uuidv4();
        const insertCols: string[] = ['"id"'];
        const insertVals: unknown[] = [lossId];
        const placeholders: string[] = ['$1'];

        const addIf = (column: string, value: unknown) => {
          if (!columns.has(column)) return;
          insertCols.push(`"${column}"`);
          insertVals.push(value);
          placeholders.push(`$${insertVals.length}`);
        };

        addIf('name', lead.name ?? '');
        addIf('emailsPrimaryEmail', lead.emails?.primaryEmail ?? '');
        addIf(
          'emailsAdditionalEmails',
          JSON.stringify(lead.emails?.additionalEmails ?? []),
        );
        addIf(
          'phonesPrimaryPhoneNumber',
          lead.phones?.primaryPhoneNumber ?? '',
        );
        addIf(
          'phonesPrimaryPhoneCountryCode',
          lead.phones?.primaryPhoneCountryCode ?? '',
        );
        addIf('phonesPrimaryPhoneCallingCode', '');
        addIf(
          'phonesAdditionalPhones',
          JSON.stringify(lead.phones?.additionalPhones ?? []),
        );
        addIf('source', lead.source ?? '');
        addIf('sourceDetail', lead.sourceDetail ?? '');
        addIf('needs', lead.needs ?? '');
        addIf('companyRevenue', lead.companyRevenue ?? '');
        addIf('industry', lead.industry ?? '');
        addIf(
          'estimatedValueAmountMicros',
          lead.estimatedValue?.amountMicros ?? null,
        );
        addIf(
          'estimatedValueCurrencyCode',
          lead.estimatedValue?.currencyCode ?? 'USD',
        );
        addIf(
          'linkedinLinkPrimaryLinkLabel',
          lead.linkedinLink?.primaryLinkLabel ?? '',
        );
        addIf(
          'linkedinLinkPrimaryLinkUrl',
          lead.linkedinLink?.primaryLinkUrl ?? '',
        );
        addIf(
          'linkedinLinkSecondaryLinks',
          JSON.stringify(lead.linkedinLink?.secondaryLinks ?? []),
        );
        addIf('position', 0);

        if (columns.has('createdAt')) {
          insertCols.push('"createdAt"');
          placeholders.push('NOW()');
        }
        if (columns.has('updatedAt')) {
          insertCols.push('"updatedAt"');
          placeholders.push('NOW()');
        }

        const sql = `INSERT INTO "${schema}"."_loss" (${insertCols.join(', ')})
          VALUES (${placeholders.join(', ')})`;

        await this.dataSource.query(sql, insertVals);

        // Carry over notes/tasks if targetLossId exists on the junction tables.
        const noteTargetHasLoss = await this.columnExists(
          schema,
          'noteTarget',
          'targetLossId',
        );

        if (noteTargetHasLoss) {
          await this.dataSource.query(
            `UPDATE "${schema}"."noteTarget"
             SET "targetLossId" = $1
             WHERE "targetLeadId" = $2 AND "targetLossId" IS NULL`,
            [lossId, event.recordId],
          );
        }

        const taskTargetHasLoss = await this.columnExists(
          schema,
          'taskTarget',
          'targetLossId',
        );

        if (taskTargetHasLoss) {
          await this.dataSource.query(
            `UPDATE "${schema}"."taskTarget"
             SET "targetLossId" = $1
             WHERE "targetLeadId" = $2 AND "targetLossId" IS NULL`,
            [lossId, event.recordId],
          );
        }

        // Emit real-time CREATED event so the Losses view updates live
        await this.eventEmitter.emitCreated(
          'loss',
          lossId,
          { name: lead.name ?? '' },
          payload.workspaceId,
        );

        this.logger.log(
          `Created loss ${lossId} ("${lead.name}") from lost lead ${event.recordId}`,
        );
      } catch (error) {
        this.logger.error(
          `Failed to create loss from lead ${event.recordId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async getLossColumns(schema: string): Promise<Set<string>> {
    const cached = this.lossColumnsByWorkspace.get(schema);

    if (cached) return cached;

    try {
      const rows = await this.dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = '_loss'`,
        [schema],
      );
      const set = new Set<string>(
        rows.map((r: { column_name: string }) => r.column_name),
      );

      this.lossColumnsByWorkspace.set(schema, set);

      return set;
    } catch {
      return new Set<string>();
    }
  }

  private async columnExists(
    schema: string,
    table: string,
    column: string,
  ): Promise<boolean> {
    const rows = await this.dataSource.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3 LIMIT 1`,
      [schema, table, column],
    );

    return rows.length > 0;
  }
}
