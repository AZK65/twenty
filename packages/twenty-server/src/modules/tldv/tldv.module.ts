import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';

import { TldvController } from 'src/modules/tldv/controllers/tldv.controller';
import { TldvPollerService } from 'src/modules/tldv/services/tldv-poller.service';
import { TldvWebhookService } from 'src/modules/tldv/services/tldv-webhook.service';
import { TldvService } from 'src/modules/tldv/services/tldv.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [TldvController],
  providers: [TldvService, TldvWebhookService, TldvPollerService],
  exports: [TldvService, TldvWebhookService],
})
export class TldvModule {}
