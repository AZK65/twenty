import { Module } from '@nestjs/common';

import { JustcallController } from 'src/modules/justcall/controllers/justcall.controller';
import { JustcallSignatureGuard } from 'src/modules/justcall/guards/justcall-signature.guard';
import { DeepgramTranscriptionService } from 'src/modules/justcall/services/deepgram-transcription.service';
import { JustcallWebhookService } from 'src/modules/justcall/services/justcall-webhook.service';
import { JustcallService } from 'src/modules/justcall/services/justcall.service';

@Module({
  imports: [],
  controllers: [JustcallController],
  providers: [
    DeepgramTranscriptionService,
    JustcallService,
    JustcallSignatureGuard,
    JustcallWebhookService,
  ],
  exports: [JustcallService, JustcallWebhookService],
})
export class JustcallModule {}
