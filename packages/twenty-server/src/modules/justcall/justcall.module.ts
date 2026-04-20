import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';
import { JustcallController } from 'src/modules/justcall/controllers/justcall.controller';
import { JustcallSignatureGuard } from 'src/modules/justcall/guards/justcall-signature.guard';
import { DeepgramTranscriptionService } from 'src/modules/justcall/services/deepgram-transcription.service';
import { JustcallWebhookService } from 'src/modules/justcall/services/justcall-webhook.service';
import { JustcallService } from 'src/modules/justcall/services/justcall.service';

@Module({
  imports: [AuthModule, WorkspaceCacheStorageModule],
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
