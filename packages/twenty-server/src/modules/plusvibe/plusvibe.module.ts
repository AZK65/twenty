import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';
import { PlusvibeController } from 'src/modules/plusvibe/controllers/plusvibe.controller';
import { PlusvibeService } from 'src/modules/plusvibe/services/plusvibe.service';

@Module({
  imports: [AuthModule, WorkspaceCacheStorageModule],
  controllers: [PlusvibeController],
  providers: [PlusvibeService],
  exports: [PlusvibeService],
})
export class PlusvibeModule {}
