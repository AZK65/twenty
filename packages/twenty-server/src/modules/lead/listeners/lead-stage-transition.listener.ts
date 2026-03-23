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
  LEAD_STAGE_SEQUENCES,
  type LeadSequenceStep,
} from 'src/modules/lead/constants/lead-stage-sequences.constant';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

export type LeadStageSequenceJobData = {
  workspaceId: string;
  leadId: string;
  leadName: string;
  previousStage: string;
  newStage: string;
  step: LeadSequenceStep;
  triggeredByUserId: string | null;
};

export const LEAD_STAGE_SEQUENCE_JOB = 'LeadStageSequenceJob';

@Injectable()
export class LeadStageTransitionListener {
  private readonly logger = new Logger(LeadStageTransitionListener.name);

  constructor(
    @InjectMessageQueue(MessageQueue.emailQueue)
    private readonly messageQueueService: MessageQueueService,
  ) {}

  @OnDatabaseBatchEvent('lead', DatabaseEventAction.UPDATED)
  async handleLeadStageUpdated(
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

      if (!isDefined(newStage) || newStage === previousStage) {
        continue;
      }

      this.logger.log(
        `Lead ${event.recordId} transitioned from "${previousStage ?? 'none'}" to "${newStage}" in workspace ${payload.workspaceId}`,
      );

      const sequence = LEAD_STAGE_SEQUENCES[newStage];

      if (!isDefined(sequence)) {
        this.logger.warn(
          `No sequence defined for lead stage "${newStage}"`,
        );

        continue;
      }

      this.logger.log(
        `Executing sequence "${sequence.name}" with ${sequence.steps.length} step(s) for lead ${event.recordId}`,
      );

      for (const step of sequence.steps) {
        const delayInMilliseconds =
          step.delay > 0 ? step.delay * 60 * 1000 : 0;

        await this.messageQueueService.add<LeadStageSequenceJobData>(
          LEAD_STAGE_SEQUENCE_JOB,
          {
            workspaceId: payload.workspaceId,
            leadId: event.recordId,
            leadName: event.properties.after.name ?? '',
            previousStage: previousStage ?? '',
            newStage,
            step,
            triggeredByUserId: event.userId ?? null,
          },
          {
            retryLimit: 3,
            ...(delayInMilliseconds > 0 && { delay: delayInMilliseconds }),
          },
        );
      }
    }
  }
}
