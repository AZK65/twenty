import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { WorkspaceCacheStorageModule } from 'src/engine/workspace-cache-storage/workspace-cache-storage.module';
import { DocPageController } from 'src/modules/doc-page/doc-page.controller';

@Module({
  imports: [AuthModule, WorkspaceCacheStorageModule],
  controllers: [DocPageController],
})
export class DocPageModule {}
