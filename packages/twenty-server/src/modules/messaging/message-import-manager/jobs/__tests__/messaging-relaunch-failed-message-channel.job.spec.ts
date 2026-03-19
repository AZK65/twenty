import { type Provider } from '@nestjs/common';
import { Test, type TestingModule } from '@nestjs/testing';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import {
  MessageChannelSyncStage,
  MessageChannelSyncStatus,
  type MessageChannelWorkspaceEntity,
} from 'src/modules/messaging/common/standard-objects/message-channel.workspace-entity';
import { MessagingRelaunchFailedMessageChannelJob } from 'src/modules/messaging/message-import-manager/jobs/messaging-relaunch-failed-message-channel.job';

describe('MessagingRelaunchFailedMessageChannelJob', () => {
  let job: MessagingRelaunchFailedMessageChannelJob;
  let mockUpdate: jest.Mock;
  let mockFindOne: jest.Mock;

  const workspaceId = 'workspace-id';
  const messageChannelId = 'message-channel-id';

  beforeEach(async () => {
    mockUpdate = jest.fn();
    mockFindOne = jest.fn();

    const mockRepository = {
      findOne: mockFindOne,
      update: mockUpdate,
    };

    const providers: Provider[] = [
      MessagingRelaunchFailedMessageChannelJob,
      {
        provide: GlobalWorkspaceOrmManager,
        useValue: {
          executeInWorkspaceContext: jest
            .fn()
            .mockImplementation((callback) => callback()),
          getRepository: jest.fn().mockResolvedValue(mockRepository),
        },
      },
    ];

    const module: TestingModule = await Test.createTestingModule({
      providers,
    }).compile();

    job = await module.resolve(MessagingRelaunchFailedMessageChannelJob);
  });

  it('should reset throttle state when relaunching a failed channel', async () => {
    mockFindOne.mockResolvedValue({
      id: messageChannelId,
      syncStage: MessageChannelSyncStage.FAILED,
      syncStatus: MessageChannelSyncStatus.FAILED_UNKNOWN,
      throttleFailureCount: 5,
      throttleRetryAfter: '2026-03-19T06:49:34.295Z',
      syncStageStartedAt: '2026-03-19T06:34:34.000Z',
    } as Partial<MessageChannelWorkspaceEntity>);

    await job.handle({ workspaceId, messageChannelId });

    expect(mockUpdate).toHaveBeenCalledWith(messageChannelId, {
      syncStage: MessageChannelSyncStage.MESSAGE_LIST_FETCH_PENDING,
      syncStatus: MessageChannelSyncStatus.ACTIVE,
      throttleFailureCount: 0,
      throttleRetryAfter: null,
      syncStageStartedAt: null,
    });
  });

});
