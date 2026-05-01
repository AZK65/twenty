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

// On any Lead update, mirror overlapping columns onto the matched
// Person (Client) and Loss records.
//
// Match keys:
//   Lead -> Person: emailsPrimaryEmail
//   Lead -> Loss:   name
//
// Columns synced: any column that exists on BOTH lead and the target table,
// excluding system + identity columns. Schema is queried at runtime so
// new fields added via Settings → Data Model start syncing automatically.

const SYSTEM_COLUMNS = new Set([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'position',
  'searchVector',
  'createdBySource',
  'createdByWorkspaceMemberId',
  'createdByName',
  'createdByContext',
  'updatedBySource',
  'updatedByWorkspaceMemberId',
  'updatedByName',
  'updatedByContext',
]);

// Identity columns we use as the join key — never touch these on the target.
const PERSON_IDENTITY = new Set(['emailsPrimaryEmail']);
const LOSS_IDENTITY = new Set(['name']);

// Lead-only columns that don't make sense to push to Client/Loss
// (stage etc would be confusing/wrong on those objects).
const SKIP_COLUMNS = new Set([
  'stage',
  'enrichmentStatus',
  'priority',
  'nextFollowUpDate',
  'assignedToId',
  'ownerId',
]);

type ColumnCache = {
  lead: Set<string>;
  person: Set<string>;
  loss: Set<string>;
};

@Injectable()
export class LeadFieldsSyncListener {
  private readonly logger = new Logger(LeadFieldsSyncListener.name);
  private columnCache = new Map<string, ColumnCache>();

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

    const schema = getWorkspaceSchemaName(payload.workspaceId);
    const cols = await this.getColumns(schema);

    if (cols.lead.size === 0) return;

    for (const event of payload.events) {
      const lead = event.properties.after;
      const updatedFields = event.properties.diff
        ? (Object.keys(event.properties.diff) as string[])
        : null;

      // Only sync columns that actually changed (when diff is available).
      // Otherwise sync everything overlapping.
      const candidateCols = (target: Set<string>, identity: Set<string>) => {
        const overlap = [...cols.lead].filter(
          (c) =>
            target.has(c) &&
            !SYSTEM_COLUMNS.has(c) &&
            !SKIP_COLUMNS.has(c) &&
            !identity.has(c),
        );

        return updatedFields
          ? overlap.filter((c) => this.matchesUpdatedField(c, updatedFields))
          : overlap;
      };

      // === Sync to Person (Client) by emailsPrimaryEmail ===
      const email = lead.emails?.primaryEmail?.trim();

      if (email && cols.person.size > 0) {
        const colsToCopy = candidateCols(cols.person, PERSON_IDENTITY);

        if (colsToCopy.length > 0) {
          await this.copyColumns({
            schema,
            sourceTable: 'lead',
            sourceId: event.recordId,
            targetTable: 'person',
            targetWhere: '"emailsPrimaryEmail" = $1',
            targetWhereParams: [email],
            columns: colsToCopy,
            workspaceId: payload.workspaceId,
            objectName: 'person',
          });
        }
      }

      // === Sync to Loss (_loss) by name ===
      const leadName = lead.name?.trim();

      if (leadName && cols.loss.size > 0) {
        const colsToCopy = candidateCols(cols.loss, LOSS_IDENTITY);

        if (colsToCopy.length > 0) {
          await this.copyColumns({
            schema,
            sourceTable: 'lead',
            sourceId: event.recordId,
            targetTable: '_loss',
            targetWhere: 'name = $1 AND "deletedAt" IS NULL',
            targetWhereParams: [leadName],
            columns: colsToCopy,
            workspaceId: payload.workspaceId,
            objectName: 'loss',
          });
        }
      }
    }
  }

  // updatedFields entries can be top-level field names like 'phones' even
  // though we store them as 'phonesPrimaryPhoneNumber' etc. Treat them as a
  // group: if 'phones' updated, all 'phones*' columns are candidates.
  private matchesUpdatedField(
    column: string,
    updatedFields: string[],
  ): boolean {
    return updatedFields.some(
      (f) => column === f || column.startsWith(f),
    );
  }

  private async copyColumns(args: {
    schema: string;
    sourceTable: string;
    sourceId: string;
    targetTable: string;
    targetWhere: string;
    targetWhereParams: unknown[];
    columns: string[];
    workspaceId: string;
    objectName: 'person' | 'loss';
  }): Promise<void> {
    const {
      schema,
      sourceTable,
      sourceId,
      targetTable,
      targetWhere,
      targetWhereParams,
      columns,
      workspaceId,
      objectName,
    } = args;

    try {
      const colList = columns.map((c) => `"${c}"`).join(', ');
      const sourceRows = await this.dataSource.query(
        `SELECT ${colList} FROM "${schema}"."${sourceTable}" WHERE id = $1 LIMIT 1`,
        [sourceId],
      );

      if (sourceRows.length === 0) return;

      const sourceData = sourceRows[0] as Record<string, unknown>;
      const setClauses: string[] = [];
      const params: unknown[] = [];

      for (const col of columns) {
        params.push(sourceData[col]);
        setClauses.push(`"${col}" = $${params.length}`);
      }

      params.push(...targetWhereParams);
      const whereStartIdx = params.length - targetWhereParams.length + 1;
      const adjustedWhere = targetWhere.replace(
        /\$(\d+)/g,
        (_, n) => `$${parseInt(n) + setClauses.length}`,
      );

      const result = await this.dataSource.query(
        `UPDATE "${schema}"."${targetTable}"
         SET ${setClauses.join(', ')}, "updatedAt" = NOW()
         WHERE ${adjustedWhere}
         RETURNING id`,
        params,
      );

      if (result.length > 0) {
        for (const row of result as Array<{ id: string }>) {
          await this.eventEmitter.emitUpdated(
            objectName,
            row.id,
            {},
            sourceData,
            workspaceId,
          );
        }
        this.logger.log(
          `Synced ${columns.length} field(s) Lead ${sourceId} → ${targetTable} ${result.map((r: { id: string }) => r.id).join(', ')}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Failed sync Lead ${sourceId} → ${targetTable}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async getColumns(schema: string): Promise<ColumnCache> {
    const cached = this.columnCache.get(schema);

    if (cached) return cached;

    const fetch = async (table: string): Promise<Set<string>> => {
      const rows = await this.dataSource.query(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2`,
        [schema, table],
      );

      return new Set(rows.map((r: { column_name: string }) => r.column_name));
    };

    const result: ColumnCache = {
      lead: await fetch('lead'),
      person: await fetch('person'),
      loss: await fetch('_loss'),
    };

    this.columnCache.set(schema, result);

    return result;
  }
}
