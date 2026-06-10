import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';
import { SalesDealSyncListener } from 'src/modules/sales-deal/listeners/sales-deal-sync.listener';
import { SalesDealController } from 'src/modules/sales-deal/sales-deal.controller';

@Module({
  imports: [AuthModule, WorkspaceCacheStorageModule],
  controllers: [SalesDealController],
  providers: [SalesDealSyncListener],
})
export class SalesDealModule {}
