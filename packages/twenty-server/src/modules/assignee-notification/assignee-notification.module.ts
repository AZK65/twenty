import { Module } from '@nestjs/common';

import { RecordUpdateNotificationJob } from 'src/modules/assignee-notification/jobs/record-update-notification.job';
import { RecordUpdateNotificationListener } from 'src/modules/assignee-notification/listeners/record-update.listener';
import { TargetCreatedListener } from 'src/modules/assignee-notification/listeners/target-created.listener';

@Module({
  providers: [
    RecordUpdateNotificationJob,
    RecordUpdateNotificationListener,
    TargetCreatedListener,
  ],
})
export class AssigneeNotificationModule {}
