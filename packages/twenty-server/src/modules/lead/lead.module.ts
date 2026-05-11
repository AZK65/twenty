import { Module } from '@nestjs/common';

import { WorkspaceCacheModule } from 'src/engine/workspace-cache/workspace-cache.module';
import { LeadWebhookController } from 'src/modules/lead/controllers/lead-webhook.controller';
import { WebhookAuthGuard } from 'src/modules/lead/guards/webhook-auth.guard';
import { LeadAssignmentNotificationJob } from 'src/modules/lead/jobs/lead-assignment-notification.job';
import { LeadAssignmentListener } from 'src/modules/lead/listeners/lead-assignment.listener';
import { LeadEnrichmentListener } from 'src/modules/lead/listeners/lead-enrichment.listener';
import { LeadStageTransitionListener } from 'src/modules/lead/listeners/lead-stage-transition.listener';
import { LeadFieldsSyncListener } from 'src/modules/lead/listeners/lead-fields-sync.listener';
import { LeadHideOnFinalStageListener } from 'src/modules/lead/listeners/lead-hide-on-final-stage.listener';
import { MirrorStageListener } from 'src/modules/lead/listeners/mirror-stage.listener';
import { LeadLostToLossListener } from 'src/modules/lead/listeners/lead-lost-to-loss.listener';
import { LeadSentProposalToOpportunityListener } from 'src/modules/lead/listeners/lead-sent-proposal-to-opportunity.listener';
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
import { TelegramFollowupService } from 'src/modules/lead/services/telegram-followup.service';
import { TelegramLeadOpsService } from 'src/modules/lead/services/telegram-lead-ops.service';
import { TelegramQAService } from 'src/modules/lead/services/telegram-qa.service';

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
    LeadFieldsSyncListener,
    LeadHideOnFinalStageListener,
    MirrorStageListener,
    LeadLostToLossListener,
    LeadSentProposalToOpportunityListener,
    LeadWebhookService,
    LeadWonToClientListener,
    LeadEventEmitterService,
    RenCallBookedListener,
    RenCustomerStatusListener,
    RenWebhookService,
    SendblueService,
    TelegramBotService,
    TelegramFollowupService,
    TelegramLeadOpsService,
    TelegramQAService,
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
