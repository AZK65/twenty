import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  UseGuards,
} from '@nestjs/common';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';
import { PlusvibeService } from 'src/modules/plusvibe/services/plusvibe.service';

type SendLeadsBody = {
  leadIds?: string[];
  matchAllFilters?: boolean;
  campaignId: string;
  filters?: {
    companyRevenues?: string[];
    minAgeDays?: number;
    maxAgeDays?: number;
  };
};

type PreviewBody = {
  filters?: {
    companyRevenues?: string[];
    minAgeDays?: number;
    maxAgeDays?: number;
  };
};

@Controller()
export class PlusvibeController {
  private readonly logger = new Logger(PlusvibeController.name);

  constructor(private readonly plusvibeService: PlusvibeService) {}

  @Get('rest/integrations/plusvibe/campaigns')
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async listCampaigns() {
    return { data: await this.plusvibeService.listCampaigns() };
  }

  @Post('rest/integrations/plusvibe/preview')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async preview(@Body() body: PreviewBody) {
    const authContext = getWorkspaceAuthContext();
    const workspaceId = authContext.workspace?.id;

    if (!workspaceId) {
      throw new BadRequestException('Workspace context not found.');
    }

    return this.plusvibeService.previewMatching(
      workspaceId,
      body.filters ?? {},
      1000,
    );
  }

  @Post('rest/integrations/plusvibe/send-leads')
  @HttpCode(200)
  @UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
  async sendLeads(@Body() body: SendLeadsBody) {
    const authContext = getWorkspaceAuthContext();
    const workspaceId = authContext.workspace?.id;

    if (!workspaceId) {
      throw new BadRequestException('Workspace context not found.');
    }

    if (!body.campaignId) {
      throw new BadRequestException('campaignId is required.');
    }

    let leadIds = body.leadIds ?? [];

    if (leadIds.length === 0 && body.matchAllFilters) {
      leadIds = await this.plusvibeService.queryMatchingLeadIds(
        workspaceId,
        body.filters ?? {},
      );
    }

    if (leadIds.length === 0) {
      throw new BadRequestException(
        'No leads to send. Adjust filters or select leads.',
      );
    }

    const result = await this.plusvibeService.pushLeadsToCampaign(
      leadIds,
      body.campaignId,
      workspaceId,
      body.filters ?? {},
    );

    return { success: true, ...result };
  }
}
