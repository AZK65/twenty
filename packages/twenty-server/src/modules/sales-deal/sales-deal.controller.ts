import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';

type SalesDeal = {
  id: string;
  sourceOpportunityId: string;
  position: number;
  name: string;
  brand: string;
  companyRevenue: string;
  appticsCrm: string;
  stage: string;
  leadSource: string;
  salesRep: string;
  mrr: number | null;
  jakePay: number | null;
  finityPay: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

const SELECT_COLUMNS = `id, "sourceOpportunityId", position, name, brand,
  "companyRevenue", "appticsCrm", stage, "leadSource", "salesRep",
  mrr, "jakePay", "finityPay", notes, "createdAt", "updatedAt"`;

// Sales Deals payout sheet — one row per won opportunity, fed by the
// SalesDealSyncListener. Stored in a core table to avoid metadata migrations,
// mirroring the SalesDocs module. Money + notes are edited here; the
// transferred columns are kept in sync from the source opportunity.
@Controller('rest/sales-deals')
@UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
export class SalesDealController {
  constructor(
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  @Get()
  async list(): Promise<SalesDeal[]> {
    const { workspace } = getWorkspaceAuthContext();

    return this.coreDataSource.query(
      `SELECT ${SELECT_COLUMNS}
         FROM core.sales_deal
        WHERE "workspaceId" = $1
        ORDER BY position ASC, "createdAt" ASC`,
      [workspace.id],
    );
  }

  // Only money/notes and the unsynced manual fields are writable here.
  // Transferred fields (name, companyRevenue, appticsCrm, stage, salesRep)
  // can change only via the opportunity sync.
  @Patch(':id')
  async update(
    @Param('id') id: string,
    @Body()
    body: {
      mrr?: number | null;
      jakePay?: number | null;
      finityPay?: number | null;
      notes?: string;
      brand?: string;
      leadSource?: string;
    },
  ): Promise<SalesDeal> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: SalesDeal[] = await this.coreDataSource.query(
      `UPDATE core.sales_deal
          SET mrr = COALESCE($3, mrr),
              "jakePay" = COALESCE($4, "jakePay"),
              "finityPay" = COALESCE($5, "finityPay"),
              notes = COALESCE($6, notes),
              brand = COALESCE($7, brand),
              "leadSource" = COALESCE($8, "leadSource"),
              "updatedAt" = now()
        WHERE id = $1 AND "workspaceId" = $2
       RETURNING ${SELECT_COLUMNS}`,
      [
        id,
        workspace.id,
        body.mrr ?? null,
        body.jakePay ?? null,
        body.finityPay ?? null,
        body.notes ?? null,
        body.brand ?? null,
        body.leadSource ?? null,
      ],
    );

    const deal = rows[0];

    // Auto-fill payouts when mrr or leadSource changed, unless the caller set a
    // manual jakePay/finityPay in the same request (manual override wins).
    const driverChanged =
      body.mrr !== undefined || body.leadSource !== undefined;
    const manualPayout =
      body.jakePay !== undefined || body.finityPay !== undefined;

    if (deal !== undefined && driverChanged && !manualPayout) {
      const { jakePay, finityPay } = this.computePayouts(
        deal.mrr,
        deal.leadSource,
      );

      const recomputed: SalesDeal[] = await this.coreDataSource.query(
        `UPDATE core.sales_deal
            SET "jakePay" = $3, "finityPay" = $4, "updatedAt" = now()
          WHERE id = $1 AND "workspaceId" = $2
         RETURNING ${SELECT_COLUMNS}`,
        [id, workspace.id, jakePay, finityPay],
      );

      return recomputed[0];
    }

    return deal;
  }

  // Spec payout formula: Jake gets 10% of MRR (20% if leadSource is "Jake");
  // Finity gets 10% only when leadSource is "Finity", else 0.
  private computePayouts(
    mrr: number | null,
    leadSource: string,
  ): { jakePay: number | null; finityPay: number | null } {
    const amount = mrr === null ? NaN : Number(mrr);

    if (Number.isNaN(amount)) {
      return { jakePay: null, finityPay: null };
    }

    const source = (leadSource ?? '').trim().toLowerCase();

    return {
      jakePay: source === 'jake' ? amount * 0.2 : amount * 0.1,
      finityPay: source === 'finity' ? amount * 0.1 : 0,
    };
  }

  @Post('reorder')
  async reorder(@Body() body: { orderedIds: string[] }): Promise<{ ok: true }> {
    const { workspace } = getWorkspaceAuthContext();
    const orderedIds = body.orderedIds ?? [];

    await this.coreDataSource.transaction(async (manager) => {
      for (let index = 0; index < orderedIds.length; index++) {
        await manager.query(
          `UPDATE core.sales_deal
              SET position = $3, "updatedAt" = now()
            WHERE id = $1 AND "workspaceId" = $2`,
          [orderedIds[index], workspace.id, index],
        );
      }
    });

    return { ok: true };
  }

  // Deleting a deal only removes it from this sheet; the source opportunity
  // and any CRM pipeline are untouched.
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ ok: true }> {
    const { workspace } = getWorkspaceAuthContext();

    await this.coreDataSource.query(
      `DELETE FROM core.sales_deal
        WHERE id = $1 AND "workspaceId" = $2`,
      [id, workspace.id],
    );

    return { ok: true };
  }
}
