import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';
import { JustcallSignatureGuard } from 'src/modules/justcall/guards/justcall-signature.guard';
import { JustcallWebhookService } from 'src/modules/justcall/services/justcall-webhook.service';
import { JustcallService } from 'src/modules/justcall/services/justcall.service';

type SendLeadsBody = {
  // Explicit lead IDs (from checkbox selection), OR pass matchAllFilters=true
  // to fall back to the filter query across all leads in the workspace.
  leadIds?: string[];
  matchAllFilters?: boolean;
  // Provide either an existing campaignId, or a new campaign spec.
  campaignId?: number;
  newCampaign?: {
    name: string;
    phoneNumberId: number | string;
  };
  filters?: {
    companyRevenues?: string[];
    usOnly?: boolean;
    maxAgeDays?: number;
  };
};

type PreviewBody = {
  filters?: {
    companyRevenues?: string[];
    usOnly?: boolean;
    maxAgeDays?: number;
  };
};

@Controller()
export class JustcallController {
  private readonly logger = new Logger(JustcallController.name);

  constructor(
    private readonly justcallService: JustcallService,
    private readonly justcallWebhookService: JustcallWebhookService,
  ) {}

  // ─── Outbound: CRM → JustCall ────────────────────────────────────────
  // Authenticated via JWT + Workspace context, same as other internal REST.

  @Get('rest/integrations/justcall/campaigns')
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async listCampaigns() {
    return { data: await this.justcallService.listCampaigns() };
  }

  @Get('rest/integrations/justcall/phones')
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async listPhones() {
    return { data: await this.justcallService.listPhoneNumbers() };
  }

  @Get('rest/integrations/justcall/revenue-values')
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async listRevenueValues() {
    const authContext = getWorkspaceAuthContext();
    const workspaceId = authContext.workspace?.id;

    if (!workspaceId) {
      throw new BadRequestException('Workspace context not found.');
    }

    return { data: await this.justcallService.listRevenueValues(workspaceId) };
  }

  @Post('rest/integrations/justcall/preview')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async preview(@Body() body: PreviewBody) {
    const authContext = getWorkspaceAuthContext();
    const workspaceId = authContext.workspace?.id;

    if (!workspaceId) {
      throw new BadRequestException('Workspace context not found.');
    }

    return this.justcallService.previewMatching(
      workspaceId,
      body.filters ?? {},
      1000,
    );
  }

  @Post('rest/integrations/justcall/send-leads')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async sendLeads(@Body() body: SendLeadsBody) {
    const authContext = getWorkspaceAuthContext();
    const workspaceId = authContext.workspace?.id;

    if (!workspaceId) {
      throw new BadRequestException('Workspace context not found.');
    }

    let leadIds = body.leadIds ?? [];

    if (leadIds.length === 0 && body.matchAllFilters) {
      leadIds = await this.justcallService.queryMatchingLeadIds(
        workspaceId,
        body.filters ?? {},
      );
    }

    if (leadIds.length === 0) {
      throw new BadRequestException(
        'No leads to send. Select leads or enable "send all matching" with filters.',
      );
    }

    let campaignId = body.campaignId;

    if (!campaignId) {
      if (!body.newCampaign?.name || !body.newCampaign?.phoneNumberId) {
        throw new BadRequestException(
          'Provide either campaignId or newCampaign { name, phoneNumberId }.',
        );
      }

      const created = await this.justcallService.createCampaign(
        body.newCampaign.name,
        body.newCampaign.phoneNumberId,
      );

      if (!created?.id) {
        throw new BadRequestException(
          'Failed to create JustCall campaign (no id returned).',
        );
      }

      campaignId = created.id;
      this.logger.log(
        `Created JustCall campaign "${body.newCampaign.name}" (id=${campaignId})`,
      );
    }

    const result = await this.justcallService.pushLeadsToCampaign(
      leadIds,
      campaignId,
      workspaceId,
      body.filters ?? {},
    );

    return { success: true, campaignId, ...result };
  }

  // ─── Inbound: JustCall → CRM ─────────────────────────────────────────
  // Verified via HMAC signature (JUSTCALL_WEBHOOK_SECRET).
  // Only processes outbound `call_completed` events.

  @Get('webhooks/justcall/call-events')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  handleWebhookPing() {
    // JustCall pings the URL on save to verify reachability
    return { ok: true };
  }

  @Post('webhooks/justcall/call-events')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard, JustcallSignatureGuard)
  async handleCallEvent(
    @Body() body: Record<string, unknown>,
    @Headers('x-workspace-id') headerWorkspaceId: string | undefined,
    @Query('workspaceId') queryWorkspaceId: string | undefined,
  ) {
    const workspaceId =
      headerWorkspaceId ??
      queryWorkspaceId ??
      process.env.DEFAULT_WORKSPACE_ID ??
      'dd98a860-76dd-4b80-b136-41d41be170b3';

    const event = typeof body.event === 'string' ? body.event : undefined;

    if (event && !event.toLowerCase().includes('call')) {
      return { ok: true, skipped: true };
    }

    try {
      const result = await this.justcallWebhookService.handleCallCompleted(
        body,
        workspaceId,
      );

      return { ok: true, ...result };
    } catch (error) {
      this.logger.error(
        `JustCall webhook failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      // Return 200 so JustCall doesn't retry indefinitely
      return { ok: true, error: 'Internal error' };
    }
  }
}
