import { Injectable, Logger } from '@nestjs/common';

import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { type WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import {
  RecordUpdateNotificationJob,
  type RecordUpdateNotificationJobData,
} from 'src/modules/assignee-notification/jobs/record-update-notification.job';
import { type RecordUpdateChange } from 'twenty-emails';

// Skip system + sync columns when computing meaningful field changes.
const NON_MEANINGFUL_FIELDS = new Set<string>([
  'id',
  'createdAt',
  'updatedAt',
  'deletedAt',
  'position',
  'searchVector',
  'createdBy',
  'updatedBy',
  'createdBySource',
  'createdByWorkspaceMemberId',
  'createdByName',
  'createdByContext',
  'updatedBySource',
  'updatedByWorkspaceMemberId',
  'updatedByName',
  'updatedByContext',
  // assignment changes are emitted as their own event type, not a fieldUpdated
  'assignedToId',
  'ownerId',
  // The Lead module already emits its own assignedTo / owner notification
  // via LeadAssignmentListener — keep that flow for compatibility, but we
  // own the unassign side here.
]);

type AnyRecord = Record<string, unknown> & {
  name?: string | null;
  assignedToId?: string | null;
};

@Injectable()
export class RecordUpdateNotificationListener {
  private readonly logger = new Logger(RecordUpdateNotificationListener.name);

  constructor(
    @InjectMessageQueue(MessageQueue.emailQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handleUpdated(payload, 'Lead', 'lead', /* emitAssign */ false);
  }

  @OnDatabaseBatchEvent('person', DatabaseEventAction.UPDATED)
  async handlePersonUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handleUpdated(
      payload,
      'Client',
      'person',
      /* emitAssign */ true,
    );
  }

  @OnDatabaseBatchEvent('loss', DatabaseEventAction.UPDATED)
  async handleLossUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
  ): Promise<void> {
    await this.handleUpdated(payload, 'Loss', 'loss', /* emitAssign */ true);
  }

  private async handleUpdated(
    payload: WorkspaceEventBatch<ObjectRecordUpdateEvent<AnyRecord>>,
    recordType: 'Lead' | 'Client' | 'Loss',
    objectSingularName: 'lead' | 'person' | 'loss',
    emitAssignEmail: boolean,
  ): Promise<void> {
    if (!isDefined(payload.workspaceId)) return;

    for (const event of payload.events) {
      const before = event.properties.before ?? {};
      const after = event.properties.after ?? {};
      const recordName = this.computeRecordName(after);

      const beforeAssignedToId = (before as AnyRecord).assignedToId ?? null;
      const afterAssignedToId = (after as AnyRecord).assignedToId ?? null;

      // Assignment branch
      if (beforeAssignedToId !== afterAssignedToId) {
        // Unassign email to the previous assignee (always)
        if (isDefined(beforeAssignedToId)) {
          await this.enqueue({
            workspaceId: payload.workspaceId,
            recordType,
            recordObjectSingularName: objectSingularName,
            recordId: event.recordId,
            recordName,
            assignedWorkspaceMemberId: beforeAssignedToId,
            actorUserId: event.userId ?? null,
            eventType: 'unassigned',
          });
        }

        // Assign email to the new assignee — only for person/loss.
        // Lead is handled by the existing LeadAssignmentListener to keep
        // its TimelineActivity creation intact.
        if (emitAssignEmail && isDefined(afterAssignedToId)) {
          await this.enqueue({
            workspaceId: payload.workspaceId,
            recordType,
            recordObjectSingularName: objectSingularName,
            recordId: event.recordId,
            recordName,
            assignedWorkspaceMemberId: afterAssignedToId,
            actorUserId: event.userId ?? null,
            eventType: 'assigned',
          });
        }
      }

      // Field-update branch — only meaningful field changes, only to current assignee
      if (!isDefined(afterAssignedToId)) continue;

      const changes = this.computeMeaningfulChanges(before, after);

      if (changes.length === 0) continue;

      await this.enqueue({
        workspaceId: payload.workspaceId,
        recordType,
        recordObjectSingularName: objectSingularName,
        recordId: event.recordId,
        recordName,
        assignedWorkspaceMemberId: afterAssignedToId,
        actorUserId: event.userId ?? null,
        eventType: 'fieldUpdated',
        changes,
      });
    }
  }

  private async enqueue(data: RecordUpdateNotificationJobData): Promise<void> {
    try {
      await this.messageQueueService.add<RecordUpdateNotificationJobData>(
        RecordUpdateNotificationJob.name,
        data,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to enqueue ${data.eventType} email for ${data.recordType} ${data.recordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private computeRecordName(after: AnyRecord): string {
    if (typeof after.name === 'string' && after.name.trim().length > 0) {
      return after.name;
    }

    const firstName = (after as { nameFirstName?: string }).nameFirstName ?? '';
    const lastName = (after as { nameLastName?: string }).nameLastName ?? '';
    const composed = `${firstName} ${lastName}`.trim();

    return composed.length > 0 ? composed : 'Unnamed';
  }

  private computeMeaningfulChanges(
    before: AnyRecord,
    after: AnyRecord,
  ): RecordUpdateChange[] {
    const changes: RecordUpdateChange[] = [];

    for (const key of Object.keys(after)) {
      if (NON_MEANINGFUL_FIELDS.has(key)) continue;
      if (key.startsWith('createdBy') || key.startsWith('updatedBy')) continue;

      const beforeValue = (before as Record<string, unknown>)[key];
      const afterValue = (after as Record<string, unknown>)[key];

      if (this.valuesEqual(beforeValue, afterValue)) continue;

      changes.push({
        field: key,
        before: this.formatValue(beforeValue),
        after: this.formatValue(afterValue),
      });
    }

    return changes;
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a === null || a === undefined) return b === null || b === undefined;
    if (b === null || b === undefined) return false;
    if (typeof a === 'object' && typeof b === 'object') {
      try {
        return JSON.stringify(a) === JSON.stringify(b);
      } catch {
        return false;
      }
    }

    return false;
  }

  private formatValue(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (value instanceof Date) return value.toISOString();
    try {
      return JSON.stringify(value);
    } catch {
      return null;
    }
  }
}
