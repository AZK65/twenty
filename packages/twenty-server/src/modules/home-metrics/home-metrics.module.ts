import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';
import { HomeMetricsController } from 'src/modules/home-metrics/home-metrics.controller';

@Module({
  imports: [AuthModule, WorkspaceCacheStorageModule],
  controllers: [HomeMetricsController],
})
export class HomeMetricsModule {}
