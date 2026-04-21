import {
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

import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { PublicEndpointGuard } from 'src/engine/guards/public-endpoint.guard';
import { TldvWebhookService } from 'src/modules/tldv/services/tldv-webhook.service';

@Controller()
export class TldvController {
  private readonly logger = new Logger(TldvController.name);

  constructor(private readonly tldvWebhookService: TldvWebhookService) {}

  @Get('webhooks/tldv/meeting-ready')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  handlePing() {
    return { ok: true };
  }

  @Post('webhooks/tldv/meeting-ready')
  @HttpCode(200)
  @UseGuards(PublicEndpointGuard, NoPermissionGuard)
  async handleMeetingReady(
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

    // Only handle MeetingReady; TranscriptReady doesn't include invitees.
    if (event && event !== 'MeetingReady') {
      return { ok: true, skipped: true, reason: `Ignored event: ${event}` };
    }

    try {
      const result = await this.tldvWebhookService.handleMeetingReady(
        body as never,
        workspaceId,
      );

      return { ok: true, ...result };
    } catch (error) {
      this.logger.error(
        `TLDV webhook failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return { ok: true, error: 'Internal error' };
    }
  }
}
