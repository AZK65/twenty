import { Controller, Get, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';
import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

type LabelValue = { label: string; value: number };

type HomeMetrics = {
  dealsByCompany: LabelValue[];
  closePercent: number;
  pipelineValueByStage: LabelValue[];
  leadSource: LabelValue[];
  dealsCreatedThisMonth: number;
  dealsWonThisMonth: number;
  dealsLostThisMonth: number;
  dealValueCreatedThisMonth: number;
};

// Home dashboard metrics. "Deals" = Opportunities; Won = stage WON; Lost = the
// Lost object (table _loss). Monthly metrics use createdAt; value = opportunity
// amount. Raw SQL against the workspace schema, like the other custom modules.
@Controller('rest/home-metrics')
@UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
export class HomeMetricsController {
  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  @Get()
  async metrics(): Promise<HomeMetrics> {
    const { workspace } = getWorkspaceAuthContext();
    const schema = getWorkspaceSchemaName(workspace.id);
    const monthStart = `date_trunc('month', now())`;

    const dealsByCompany: LabelValue[] = (
      await this.dataSource.query(
        `SELECT COALESCE(c.name, '(no company)') AS label, COUNT(*)::int AS value
           FROM "${schema}"."opportunity" o
           LEFT JOIN "${schema}"."company" c ON c.id = o."companyId"
          WHERE o."deletedAt" IS NULL
          GROUP BY c.name
          ORDER BY value DESC
          LIMIT 10`,
      )
    ).map(this.toLabelValue);

    const pipelineValueByStage: LabelValue[] = (
      await this.dataSource.query(
        `SELECT o.stage::text AS label,
                COALESCE(SUM(o."amountAmountMicros"), 0) / 1000000 AS value
           FROM "${schema}"."opportunity" o
          WHERE o."deletedAt" IS NULL
          GROUP BY o.stage
          ORDER BY value DESC`,
      )
    ).map(this.toLabelValue);

    const leadSource: LabelValue[] = (
      await this.dataSource.query(
        `SELECT COALESCE(l.source::text, '(none)') AS label, COUNT(*)::int AS value
           FROM "${schema}"."lead" l
          WHERE l."deletedAt" IS NULL
          GROUP BY l.source
          ORDER BY value DESC`,
      )
    ).map(this.toLabelValue);

    const [{ won, lost }] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM "${schema}"."opportunity" WHERE stage = 'WON' AND "deletedAt" IS NULL)::int AS won,
         (SELECT COUNT(*) FROM "${schema}"."_loss" WHERE "deletedAt" IS NULL)::int AS lost`,
    );
    const closePercent =
      won + lost > 0 ? Math.round((won / (won + lost)) * 100) : 0;

    const [monthly] = await this.dataSource.query(
      `SELECT
         (SELECT COUNT(*) FROM "${schema}"."opportunity"
           WHERE "deletedAt" IS NULL AND "createdAt" >= ${monthStart})::int AS created,
         (SELECT COUNT(*) FROM "${schema}"."opportunity"
           WHERE "deletedAt" IS NULL AND stage = 'WON' AND "updatedAt" >= ${monthStart})::int AS won,
         (SELECT COUNT(*) FROM "${schema}"."_loss"
           WHERE "deletedAt" IS NULL AND "createdAt" >= ${monthStart})::int AS lost,
         (SELECT COALESCE(SUM("amountAmountMicros"), 0) / 1000000 FROM "${schema}"."opportunity"
           WHERE "deletedAt" IS NULL AND "createdAt" >= ${monthStart}) AS value`,
    );

    return {
      dealsByCompany,
      closePercent,
      pipelineValueByStage,
      leadSource,
      dealsCreatedThisMonth: Number(monthly.created),
      dealsWonThisMonth: Number(monthly.won),
      dealsLostThisMonth: Number(monthly.lost),
      dealValueCreatedThisMonth: Number(monthly.value),
    };
  }

  private toLabelValue(row: { label: string; value: string }): LabelValue {
    return { label: row.label, value: Number(row.value) };
  }
}
