import { Logger, Scope } from '@nestjs/common';

import { render } from '@react-email/render';
import {
  RecordUpdateNotificationEmail,
  type RecordUpdateChange,
  type RecordUpdateEventType,
} from 'twenty-emails';
import { isDefined } from 'twenty-shared/utils';

import { EmailService } from 'src/engine/core-modules/email/email.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { TwentyConfigService } from 'src/engine/core-modules/twenty-config/twenty-config.service';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type RecordUpdateNotificationJobData = {
  workspaceId: string;
  recordType: 'Lead' | 'Client' | 'Loss';
  recordObjectSingularName: 'lead' | 'person' | 'loss';
  recordId: string;
  recordName: string;
  assignedWorkspaceMemberId: string;
  actorUserId: string | null;
  eventType: RecordUpdateEventType;
  changes?: RecordUpdateChange[];
  noteTitle?: string | null;
  noteBody?: string | null;
  taskTitle?: string | null;
};

@Processor({
  queueName: MessageQueue.emailQueue,
  scope: Scope.REQUEST,
})
export class RecordUpdateNotificationJob {
  private readonly logger = new Logger(RecordUpdateNotificationJob.name);

  constructor(
    private readonly emailService: EmailService,
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    private readonly twentyConfigService: TwentyConfigService,
  ) {}

  @Process(RecordUpdateNotificationJob.name)
  async handle(data: RecordUpdateNotificationJobData): Promise<void> {
    const {
      workspaceId,
      recordType,
      recordObjectSingularName,
      recordId,
      recordName,
      assignedWorkspaceMemberId,
      actorUserId,
      eventType,
      changes,
      noteTitle,
      noteBody,
      taskTitle,
    } = data;

    const authContext = buildSystemAuthContext(workspaceId);

    const assignedMember =
      await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
        async () => {
          const repo = await this.globalWorkspaceOrmManager.getRepository(
            workspaceId,
            WorkspaceMemberWorkspaceEntity,
            { shouldBypassPermissionChecks: true },
          );

          return repo.findOne({ where: { id: assignedWorkspaceMemberId } });
        },
        authContext,
      );

    if (!isDefined(assignedMember) || !isDefined(assignedMember.userEmail)) {
      return;
    }

    // Skip self-actions: if the assigned member is the one who made the change.
    if (
      isDefined(actorUserId) &&
      isDefined(assignedMember.userId) &&
      assignedMember.userId === actorUserId
    ) {
      return;
    }

    const actorName = await this.resolveActorName(workspaceId, actorUserId);

    const frontendUrl =
      this.twentyConfigService.get('FRONTEND_URL') ?? 'https://app.twenty.com';
    const recordUrl = `${frontendUrl.replace(/\/$/, '')}/object/${recordObjectSingularName}/${recordId}`;

    const locale = assignedMember.locale ?? 'en';

    const emailComponent = RecordUpdateNotificationEmail({
      recipientFirstName: assignedMember.name?.firstName ?? '',
      recordType,
      recordName,
      recordUrl,
      eventType,
      actorName,
      changes,
      noteTitle,
      noteBody,
      taskTitle,
      locale,
    });

    const html = await render(emailComponent);
    const text = await render(emailComponent, { plainText: true });

    const subject = this.subjectFor(eventType, recordType, recordName);

    const fromAddress = this.twentyConfigService.get('EMAIL_FROM_ADDRESS');
    const from = fromAddress ? `Updates <${fromAddress}>` : undefined;

    try {
      await this.emailService.send({
        from,
        to: assignedMember.userEmail,
        subject,
        text,
        html,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to send ${eventType} email to ${assignedMember.userEmail} for ${recordType} ${recordId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private subjectFor(
    eventType: RecordUpdateEventType,
    recordType: string,
    recordName: string,
  ): string {
    switch (eventType) {
      case 'assigned':
        return `You were assigned a ${recordType.toLowerCase()}: ${recordName}`;
      case 'unassigned':
        return `You were unassigned from ${recordType.toLowerCase()}: ${recordName}`;
      case 'noteAdded':
        return `New note on ${recordType.toLowerCase()}: ${recordName}`;
      case 'taskAdded':
        return `New task on ${recordType.toLowerCase()}: ${recordName}`;
      case 'fieldUpdated':
      default:
        return `Update on ${recordType.toLowerCase()}: ${recordName}`;
    }
  }

  private async resolveActorName(
    workspaceId: string,
    actorUserId: string | null,
  ): Promise<string | null> {
    if (!isDefined(actorUserId)) return null;

    const authContext = buildSystemAuthContext(workspaceId);

    const member =
      await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
        async () => {
          const repo = await this.globalWorkspaceOrmManager.getRepository(
            workspaceId,
            WorkspaceMemberWorkspaceEntity,
            { shouldBypassPermissionChecks: true },
          );

          return repo.findOne({ where: { userId: actorUserId } });
        },
        authContext,
      );

    if (!isDefined(member)) return null;

    return (
      [member.name?.firstName, member.name?.lastName]
        .filter(Boolean)
        .join(' ')
        .trim() || null
    );
  }
}
