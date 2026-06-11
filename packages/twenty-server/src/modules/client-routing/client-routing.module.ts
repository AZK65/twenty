import { Module } from '@nestjs/common';

import { OpportunityToClientListener } from 'src/modules/client-routing/opportunity-to-client.listener';

@Module({
  providers: [OpportunityToClientListener],
})
export class ClientRoutingModule {}
