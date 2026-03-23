import { Injectable } from '@nestjs/common';

import { type ObjectRecordUpdateEvent } from 'twenty-shared/database-events';
import { isDefined } from 'twenty-shared/utils';

import { OnDatabaseBatchEvent } from 'src/engine/api/graphql/graphql-query-runner/decorators/on-database-batch-event.decorator';
import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { InjectMessageQueue } from 'src/engine/core-modules/message-queue/decorators/message-queue.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { MessageQueueService } from 'src/engine/core-modules/message-queue/services/message-queue.service';
import { WorkspaceEventBatch } from 'src/engine/workspace-event-emitter/types/workspace-event-batch.type';
import {
  LeadAssignmentNotificationJob,
  type LeadAssignmentNotificationJobData,
} from 'src/modules/lead/jobs/lead-assignment-notification.job';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

@Injectable()
export class LeadAssignmentListener {
  constructor(
    @InjectMessageQueue(MessageQueue.emailQueue)
    private readonly messageQueueService: MessageQueueService,
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
      const beforeAssignedToId = event.properties.before.assignedToId;
      const afterAssignedToId = event.properties.after.assignedToId;

      const beforeOwnerId = event.properties.before.ownerId;
      const afterOwnerId = event.properties.after.ownerId;

      const assignedToChanged =
        isDefined(afterAssignedToId) &&
        afterAssignedToId !== beforeAssignedToId;

      const ownerChanged =
        isDefined(afterOwnerId) && afterOwnerId !== beforeOwnerId;

      if (assignedToChanged) {
        await this.messageQueueService.add<LeadAssignmentNotificationJobData>(
          LeadAssignmentNotificationJob.name,
          {
            workspaceId: payload.workspaceId,
            leadId: event.recordId,
            leadName: event.properties.after.name ?? '',
            assignedWorkspaceMemberId: afterAssignedToId,
            assignmentType: 'assignedTo',
            assignedByUserId: event.userId ?? null,
          },
        );
      }

      if (ownerChanged) {
        await this.messageQueueService.add<LeadAssignmentNotificationJobData>(
          LeadAssignmentNotificationJob.name,
          {
            workspaceId: payload.workspaceId,
            leadId: event.recordId,
            leadName: event.properties.after.name ?? '',
            assignedWorkspaceMemberId: afterOwnerId,
            assignmentType: 'owner',
            assignedByUserId: event.userId ?? null,
          },
        );
      }
    }
  }
}
