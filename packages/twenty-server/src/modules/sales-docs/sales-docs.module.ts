import { Module } from '@nestjs/common';

import { AuthModule } from 'src/engine/core-modules/auth/auth.module';
import { SalesDocsController } from 'src/modules/sales-docs/sales-docs.controller';

@Module({
  imports: [AuthModule],
  controllers: [SalesDocsController],
})
export class SalesDocsModule {}
