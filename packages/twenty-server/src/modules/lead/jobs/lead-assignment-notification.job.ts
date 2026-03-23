import { Scope } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { EmailService } from 'src/engine/core-modules/email/email.service';
import { Process } from 'src/engine/core-modules/message-queue/decorators/process.decorator';
import { Processor } from 'src/engine/core-modules/message-queue/decorators/processor.decorator';
import { MessageQueue } from 'src/engine/core-modules/message-queue/message-queue.constants';
import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { TimelineActivityRepository } from 'src/modules/timeline/repositories/timeline-activity.repository';
import { InjectObjectMetadataRepository } from 'src/engine/object-metadata-repository/object-metadata-repository.decorator';
import { TimelineActivityWorkspaceEntity } from 'src/modules/timeline/standard-objects/timeline-activity.workspace-entity';
import { WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

export type LeadAssignmentNotificationJobData = {
  workspaceId: string;
  leadId: string;
  leadName: string;
  assignedWorkspaceMemberId: string;
  assignmentType: 'assignedTo' | 'owner';
  assignedByUserId: string | null;
};

@Processor({
  queueName: MessageQueue.emailQueue,
  scope: Scope.REQUEST,
})
export class LeadAssignmentNotificationJob {
  constructor(
    private readonly emailService: EmailService,
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    @InjectObjectMetadataRepository(TimelineActivityWorkspaceEntity)
    private readonly timelineActivityRepository: TimelineActivityRepository,
  ) {}

  @Process(LeadAssignmentNotificationJob.name)
  async handle(data: LeadAssignmentNotificationJobData): Promise<void> {
    const { workspaceId, leadId, leadName, assignedWorkspaceMemberId } = data;

    const authContext = buildSystemAuthContext(workspaceId);

    const assignedMember =
      await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
        async () => {
          const workspaceMemberRepository =
            await this.globalWorkspaceOrmManager.getRepository(
              workspaceId,
              WorkspaceMemberWorkspaceEntity,
              {
                shouldBypassPermissionChecks: true,
              },
            );

          return workspaceMemberRepository.findOne({
            where: { id: assignedWorkspaceMemberId },
          });
        },
        authContext,
      );

    if (!isDefined(assignedMember) || !isDefined(assignedMember.userEmail)) {
      return;
    }

    const memberFullName = [
      assignedMember.name.firstName,
      assignedMember.name.lastName,
    ]
      .filter(Boolean)
      .join(' ');

    const roleLabel =
      data.assignmentType === 'owner' ? 'owner' : 'assigned member';

    await this.emailService.send({
      to: assignedMember.userEmail,
      subject: `You have been assigned a lead: ${leadName}`,
      text:
        `Hi ${memberFullName},\n\n` +
        `You have been set as the ${roleLabel} of the lead "${leadName}".\n\n` +
        `Please review the lead details in your CRM workspace.`,
      html:
        `<p>Hi ${memberFullName},</p>` +
        `<p>You have been set as the <strong>${roleLabel}</strong> of the lead ` +
        `<strong>"${leadName}"</strong>.</p>` +
        `<p>Please review the lead details in your CRM workspace.</p>`,
    });

    await this.createTimelineActivity(data);
  }

  private async createTimelineActivity(
    data: LeadAssignmentNotificationJobData,
  ): Promise<void> {
    const { workspaceId, leadId, assignmentType } = data;

    const eventName = `lead.assignment.${assignmentType}`;

    await this.timelineActivityRepository.upsertTimelineActivities({
      objectSingularName: 'lead',
      workspaceId,
      payloads: [
        {
          name: eventName,
          objectSingularName: 'lead',
          recordId: leadId,
          workspaceMemberId: data.assignedWorkspaceMemberId,
          properties: {
            diff: {
              assignmentType,
              assignedWorkspaceMemberId: data.assignedWorkspaceMemberId,
            },
          },
        },
      ],
    });
  }
}
