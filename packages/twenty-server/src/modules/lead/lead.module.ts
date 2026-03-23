import { Module } from '@nestjs/common';

import { LeadAssignmentNotificationJob } from 'src/modules/lead/jobs/lead-assignment-notification.job';
import { LeadAssignmentListener } from 'src/modules/lead/listeners/lead-assignment.listener';
import { LeadEnrichmentListener } from 'src/modules/lead/listeners/lead-enrichment.listener';
import { LeadStageTransitionListener } from 'src/modules/lead/listeners/lead-stage-transition.listener';
import { LeadEnrichmentService } from 'src/modules/lead/services/lead-enrichment.service';

@Module({
  imports: [],
  providers: [
    LeadAssignmentListener,
    LeadAssignmentNotificationJob,
    LeadEnrichmentListener,
    LeadEnrichmentService,
    LeadStageTransitionListener,
  ],
  exports: [LeadEnrichmentService],
})
export class LeadModule {}
