import { Module } from '@nestjs/common';

import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import { LeadWebhookController } from 'src/modules/lead/controllers/lead-webhook.controller';
import { WebhookAuthGuard } from 'src/modules/lead/guards/webhook-auth.guard';
import { LeadAssignmentNotificationJob } from 'src/modules/lead/jobs/lead-assignment-notification.job';
import { LeadAssignmentListener } from 'src/modules/lead/listeners/lead-assignment.listener';
import { LeadEnrichmentListener } from 'src/modules/lead/listeners/lead-enrichment.listener';
import { LeadStageTransitionListener } from 'src/modules/lead/listeners/lead-stage-transition.listener';
import { LeadWonToClientListener } from 'src/modules/lead/listeners/lead-won-to-client.listener';
import { RenCallBookedListener } from 'src/modules/lead/listeners/ren-call-booked.listener';
import { RenCustomerStatusListener } from 'src/modules/lead/listeners/ren-customer-status.listener';
import { AffiliateOutboundWebhookService } from 'src/modules/lead/services/affiliate-outbound-webhook.service';
import { CalcomWebhookService } from 'src/modules/lead/services/calcom-webhook.service';
import { CloseCrmImportService } from 'src/modules/lead/services/close-crm-import.service';
import { LeadEnrichmentService } from 'src/modules/lead/services/lead-enrichment.service';
import { LeadWebhookService } from 'src/modules/lead/services/lead-webhook.service';
import { LeadEventEmitterService } from 'src/modules/lead/services/lead-event-emitter.service';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';
import { SendblueService } from 'src/modules/lead/services/sendblue.service';
import { TelegramBotService } from 'src/modules/lead/services/telegram-bot.service';

@Module({
  imports: [WorkspaceCacheModule],
  controllers: [LeadWebhookController],
  providers: [
    AffiliateOutboundWebhookService,
    CalcomWebhookService,
    CloseCrmImportService,
    LeadAssignmentListener,
    LeadAssignmentNotificationJob,
    LeadEnrichmentListener,
    LeadEnrichmentService,
    LeadStageTransitionListener,
    LeadWebhookService,
    LeadWonToClientListener,
    LeadEventEmitterService,
    RenCallBookedListener,
    RenCustomerStatusListener,
    RenWebhookService,
    SendblueService,
    TelegramBotService,
    WebhookAuthGuard,
  ],
  exports: [
    AffiliateOutboundWebhookService,
    CalcomWebhookService,
    LeadEnrichmentService,
    LeadWebhookService,
    RenWebhookService,
    SendblueService,
  ],
})
export class LeadModule {}
