import { Module } from '@nestjs/common';

import { TldvController } from 'src/modules/tldv/controllers/tldv.controller';
import { TldvWebhookService } from 'src/modules/tldv/services/tldv-webhook.service';
import { TldvService } from 'src/modules/tldv/services/tldv.service';

@Module({
  imports: [],
  controllers: [TldvController],
  providers: [TldvService, TldvWebhookService],
  exports: [TldvService, TldvWebhookService],
})
export class TldvModule {}
