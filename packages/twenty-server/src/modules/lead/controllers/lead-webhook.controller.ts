import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  InternalServerErrorException,
  Logger,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';
import { type CalcomWebhookEvent } from 'src/modules/lead/dtos/calcom-webhook.dto';
import {
  type AffiliateWebhookPayload,
  type WebhookResponse,
} from 'src/modules/lead/dtos/webhook.dto';
import { WebhookAuthGuard } from 'src/modules/lead/guards/webhook-auth.guard';
import { CalcomWebhookService } from 'src/modules/lead/services/calcom-webhook.service';
import {
  CloseCrmImportService,
  type ImportResult,
} from 'src/modules/lead/services/close-crm-import.service';
import { LeadWebhookService } from 'src/modules/lead/services/lead-webhook.service';

@Controller('webhooks/leads')
@UseGuards(PublicEndpointGuard, NoPermissionGuard, WebhookAuthGuard)
export class LeadWebhookController {
  private readonly logger = new Logger(LeadWebhookController.name);

  constructor(
    private readonly leadWebhookService: LeadWebhookService,
    private readonly calcomWebhookService: CalcomWebhookService,
    private readonly closeCrmImportService: CloseCrmImportService,
  ) {}

  @Post('affiliate')
  @HttpCode(200)
  async handleAffiliateWebhook(
    @Body() body: AffiliateWebhookPayload,
    @Headers('x-workspace-id') headerWorkspaceId: string | undefined,
    @Query('workspaceId') queryWorkspaceId: string | undefined,
  ): Promise<WebhookResponse> {
    const workspaceId = headerWorkspaceId ?? queryWorkspaceId;

    if (!workspaceId) {
      throw new BadRequestException(
        'Missing workspaceId. Provide it via x-workspace-id header or ?workspaceId= query param.',
      );
    }

    if (!body.name || typeof body.name !== 'string' || body.name.trim().length === 0) {
      throw new BadRequestException(
        'Field "name" is required and must be a non-empty string.',
      );
    }

    try {
      const result = await this.leadWebhookService.createLeadFromAffiliate(
        body,
        workspaceId,
      );

      this.logger.log(
        `Affiliate webhook created lead ${result.leadId} in workspace ${workspaceId}`,
      );

      return { success: true, leadId: result.leadId };
    } catch (error) {
      this.logger.error(
        `Failed to create lead from affiliate webhook: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new InternalServerErrorException(
        'Failed to create lead from affiliate webhook.',
      );
    }
  }

  @Post('generic')
  @HttpCode(200)
  async handleGenericWebhook(
    @Body() body: Record<string, unknown>,
    @Headers('x-workspace-id') headerWorkspaceId: string | undefined,
    @Query('workspaceId') queryWorkspaceId: string | undefined,
  ): Promise<WebhookResponse> {
    const workspaceId = headerWorkspaceId ?? queryWorkspaceId;

    if (!workspaceId) {
      throw new BadRequestException(
        'Missing workspaceId. Provide it via x-workspace-id header or ?workspaceId= query param.',
      );
    }

    if (!body || typeof body !== 'object' || Object.keys(body).length === 0) {
      throw new BadRequestException(
        'Request body must be a non-empty JSON object.',
      );
    }

    try {
      const result = await this.leadWebhookService.createLeadFromGenericWebhook(
        body,
        workspaceId,
      );

      this.logger.log(
        `Generic webhook created lead ${result.leadId} in workspace ${workspaceId}`,
      );

      return { success: true, leadId: result.leadId };
    } catch (error) {
      this.logger.error(
        `Failed to create lead from generic webhook: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new InternalServerErrorException(
        'Failed to create lead from generic webhook.',
      );
    }
  }

  // Cal.com BOOKING_CREATED receiver.
  // Set this URL as a webhook subscriber in Cal.com:
  //   POST /webhooks/leads/calcom?workspaceId=YOUR_WORKSPACE_ID
  //
  // Pass affiliate/referral IDs via Cal.com booking page URL params:
  //   cal.com/user/meeting?metadata[affiliateId]=aff_123&metadata[referralId]=ref_456
  //
  // On booking, this creates or updates a lead → MEETING_SCHEDULED, then fires
  // the REN outbound webhook with affiliateId, referralId, and MRR.
  @Post('calcom')
  @HttpCode(200)
  async handleCalcomWebhook(
    @Body() body: CalcomWebhookEvent,
    @Headers('x-workspace-id') headerWorkspaceId: string | undefined,
    @Query('workspaceId') queryWorkspaceId: string | undefined,
  ): Promise<WebhookResponse> {
    // Default to the primary workspace if no workspaceId is provided
    const workspaceId = headerWorkspaceId
      ?? queryWorkspaceId
      ?? process.env.DEFAULT_WORKSPACE_ID
      ?? 'dd98a860-76dd-4b80-b136-41d41be170b3';

    if (!body.triggerEvent) {
      throw new BadRequestException(
        'Invalid Cal.com webhook payload: missing triggerEvent.',
      );
    }

    if (body.triggerEvent !== 'BOOKING_CREATED') {
      // Acknowledge PING and other non-booking events silently
      this.logger.debug(
        `Ignoring Cal.com event "${body.triggerEvent}" — only BOOKING_CREATED is handled`,
      );

      return { success: true };
    }

    if (!body.payload) {
      throw new BadRequestException(
        'Invalid Cal.com webhook payload: missing payload.',
      );
    }

    if (!body.payload.attendees?.length) {
      throw new BadRequestException(
        'Cal.com booking has no attendees.',
      );
    }

    try {
      const result = await this.calcomWebhookService.handleBookingCreated(
        body,
        workspaceId,
      );

      this.logger.log(
        `Cal.com booking processed: lead ${result.leadId} (${result.isNew ? 'new' : 'existing'}) in workspace ${workspaceId}`,
      );

      return { success: true, leadId: result.leadId };
    } catch (error) {
      this.logger.error(
        `Failed to process Cal.com booking: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new InternalServerErrorException(
        'Failed to process Cal.com booking webhook.',
      );
    }
  }

  // Bulk import from Close CRM JSON export.
  // POST /webhooks/leads/import/close?workspaceId=YOUR_WORKSPACE_ID
  // Body: array of Close CRM lead objects (the raw JSON export)
  @Post('import/close')
  @HttpCode(200)
  async handleCloseImport(
    @Body() body: unknown[],
    @Headers('x-workspace-id') headerWorkspaceId: string | undefined,
    @Query('workspaceId') queryWorkspaceId: string | undefined,
  ): Promise<ImportResult> {
    const workspaceId = headerWorkspaceId ?? queryWorkspaceId;

    if (!workspaceId) {
      throw new BadRequestException(
        'Missing workspaceId. Provide it via x-workspace-id header or ?workspaceId= query param.',
      );
    }

    if (!Array.isArray(body) || body.length === 0) {
      throw new BadRequestException(
        'Request body must be a non-empty JSON array of Close CRM leads.',
      );
    }

    try {
      const result = await this.closeCrmImportService.importLeads(
        body as never[],
        workspaceId,
      );

      this.logger.log(
        `Close CRM import: ${result.imported}/${result.total} leads imported to workspace ${workspaceId}`,
      );

      return result;
    } catch (error) {
      this.logger.error(
        `Close CRM import failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      throw new InternalServerErrorException(
        'Failed to import leads from Close CRM.',
      );
    }
  }
}
