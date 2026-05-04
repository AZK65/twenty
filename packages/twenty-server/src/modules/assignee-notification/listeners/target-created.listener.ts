import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { type ObjectRecordCreateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';
import { DataSource } from 'typeorm';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import {
  RecordUpdateNotificationJob,
  type RecordUpdateNotificationJobData,
} from 'src/modules/assignee-notification/jobs/record-update-notification.job';

type TargetRow = {
  noteId?: string | null;
  taskId?: string | null;
  targetPersonId?: string | null;
  targetLeadId?: string | null;
  targetLossId?: string | null;
};

@Injectable()
export class TargetCreatedListener {
  private readonly logger = new Logger(TargetCreatedListener.name);

  // Cache the existence of optional custom-target columns per schema.
  private columnExistenceCache = new Map<
    string,
    { noteTarget: Set<string>; taskTarget: Set<string> }
  >();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    @InjectMessageQueue(MessageQueue.emailQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  @OnDatabaseBatchEvent('noteTarget', DatabaseEventAction.CREATED)
  async handleNoteTargetCreated(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent<TargetRow>>,
  ): Promise<void> {
    if (!isDefined(payload.workspaceId)) return;

    for (const event of payload.events) {
      const target = event.properties.after;

      if (!isDefined(target?.noteId)) continue;

      const parent = await this.resolveParent(payload.workspaceId, target);

      if (!parent) continue;

      const note = await this.fetchNote(payload.workspaceId, target.noteId);

      await this.enqueue({
        workspaceId: payload.workspaceId,
        recordType: parent.recordType,
        recordObjectSingularName: parent.objectSingularName,
        recordId: parent.recordId,
        recordName: parent.recordName,
        assignedWorkspaceMemberId: parent.assignedToId,
        actorUserId: event.userId ?? null,
        eventType: 'noteAdded',
        noteTitle: note?.title ?? null,
        noteBody: note?.bodyText ?? null,
      });
    }
  }

  @OnDatabaseBatchEvent('taskTarget', DatabaseEventAction.CREATED)
  async handleTaskTargetCreated(
    payload: WorkspaceEventBatch<ObjectRecordCreateEvent<TargetRow>>,
  ): Promise<void> {
    if (!isDefined(payload.workspaceId)) return;

    for (const event of payload.events) {
      const target = event.properties.after;

      if (!isDefined(target?.taskId)) continue;

      const parent = await this.resolveParent(payload.workspaceId, target);

      if (!parent) continue;

      const task = await this.fetchTask(payload.workspaceId, target.taskId);

      await this.enqueue({
        workspaceId: payload.workspaceId,
        recordType: parent.recordType,
        recordObjectSingularName: parent.objectSingularName,
        recordId: parent.recordId,
        recordName: parent.recordName,
        assignedWorkspaceMemberId: parent.assignedToId,
        actorUserId: event.userId ?? null,
        eventType: 'taskAdded',
        taskTitle: task?.title ?? null,
      });
    }
  }

  private async resolveParent(
    workspaceId: string,
    target: TargetRow,
  ): Promise<{
    recordType: 'Lead' | 'Client' | 'Loss';
    objectSingularName: 'lead' | 'person' | 'loss';
    recordId: string;
    recordName: string;
    assignedToId: string;
  } | null> {
    const schema = getWorkspaceSchemaName(workspaceId);

    if (isDefined(target.targetLeadId)) {
      const row = await this.fetchLead(schema, target.targetLeadId);

      if (row?.assignedToId) {
        return {
          recordType: 'Lead',
          objectSingularName: 'lead',
          recordId: target.targetLeadId,
          recordName: row.name ?? 'Unnamed',
          assignedToId: row.assignedToId,
        };
      }
    }

    if (isDefined(target.targetPersonId)) {
      const row = await this.fetchPerson(schema, target.targetPersonId);

      if (row?.assignedToId) {
        return {
          recordType: 'Client',
          objectSingularName: 'person',
          recordId: target.targetPersonId,
          recordName: row.name ?? 'Unnamed',
          assignedToId: row.assignedToId,
        };
      }
    }

    if (isDefined(target.targetLossId)) {
      const row = await this.fetchLoss(schema, target.targetLossId);

      if (row?.assignedToId) {
        return {
          recordType: 'Loss',
          objectSingularName: 'loss',
          recordId: target.targetLossId,
          recordName: row.name ?? 'Unnamed',
          assignedToId: row.assignedToId,
        };
      }
    }

    return null;
  }

  private async fetchLead(
    schema: string,
    id: string,
  ): Promise<{ name: string | null; assignedToId: string | null } | null> {
    try {
      const rows = await this.dataSource.query(
        `SELECT "name", "assignedToId" FROM "${schema}"."lead" WHERE id = $1 LIMIT 1`,
        [id],
      );

      return rows[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `fetchLead failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async fetchPerson(
    schema: string,
    id: string,
  ): Promise<{ name: string | null; assignedToId: string | null } | null> {
    try {
      const cols = await this.checkPersonHasAssignedTo(schema);

      if (!cols) return null;

      const rows = await this.dataSource.query(
        `SELECT
          TRIM(CONCAT(COALESCE("nameFirstName", ''), ' ', COALESCE("nameLastName", ''))) AS "name",
          "assignedToId"
         FROM "${schema}"."person" WHERE id = $1 LIMIT 1`,
        [id],
      );

      return rows[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `fetchPerson failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async fetchLoss(
    schema: string,
    id: string,
  ): Promise<{ name: string | null; assignedToId: string | null } | null> {
    try {
      const cols = await this.checkLossHasAssignedTo(schema);

      if (!cols) return null;

      const rows = await this.dataSource.query(
        `SELECT "name", "assignedToId" FROM "${schema}"."_loss" WHERE id = $1 LIMIT 1`,
        [id],
      );

      return rows[0] ?? null;
    } catch (error) {
      this.logger.warn(
        `fetchLoss failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  private async fetchNote(
    workspaceId: string,
    noteId: string,
  ): Promise<{ title: string | null; bodyText: string | null } | null> {
    try {
      const schema = getWorkspaceSchemaName(workspaceId);
      const rows = await this.dataSource.query(
        `SELECT "title", LEFT(COALESCE("bodyV2Markdown", ''), 500) AS "bodyText"
         FROM "${schema}"."note" WHERE id = $1 LIMIT 1`,
        [noteId],
      );

      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async fetchTask(
    workspaceId: string,
    taskId: string,
  ): Promise<{ title: string | null } | null> {
    try {
      const schema = getWorkspaceSchemaName(workspaceId);
      const rows = await this.dataSource.query(
        `SELECT "title" FROM "${schema}"."task" WHERE id = $1 LIMIT 1`,
        [taskId],
      );

      return rows[0] ?? null;
    } catch {
      return null;
    }
  }

  private async checkPersonHasAssignedTo(schema: string): Promise<boolean> {
    return this.checkColumnExists(schema, 'person', 'assignedToId');
  }

  private async checkLossHasAssignedTo(schema: string): Promise<boolean> {
    return this.checkColumnExists(schema, '_loss', 'assignedToId');
  }

  private async checkColumnExists(
    schema: string,
    table: string,
    column: string,
  ): Promise<boolean> {
    const cacheKey = `${schema}:${table}`;
    const cached = this.columnExistenceCache.get(schema);

    // Reuse the same cache map shape; we treat the table-key sets as
    // "columns we've confirmed exist". For simplicity, do a per-call query
    // and short-circuit if found in cache.
    if (cached) {
      const set =
        table === 'noteTarget' ? cached.noteTarget : cached.taskTarget;

      if (set.has(`${cacheKey}:${column}`)) return true;
    }

    const rows = await this.dataSource.query(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = $1 AND table_name = $2 AND column_name = $3
       LIMIT 1`,
      [schema, table, column],
    );

    const exists = rows.length > 0;

    if (exists) {
      const entry = this.columnExistenceCache.get(schema) ?? {
        noteTarget: new Set<string>(),
        taskTarget: new Set<string>(),
      };

      entry.noteTarget.add(`${cacheKey}:${column}`);
      entry.taskTarget.add(`${cacheKey}:${column}`);
      this.columnExistenceCache.set(schema, entry);
    }

    return exists;
  }

  private async enqueue(data: RecordUpdateNotificationJobData): Promise<void> {
    try {
      await this.messageQueueService.add<RecordUpdateNotificationJobData>(
        RecordUpdateNotificationJob.name,
        data,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue ${data.eventType} email: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
