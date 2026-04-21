import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { TldvService } from 'src/modules/tldv/services/tldv.service';
import { TldvWebhookService } from 'src/modules/tldv/services/tldv-webhook.service';

// TLDV webhooks are enterprise-only. Poll the list endpoint every 10 min,
// skip meetings we've already processed (tracked via timeline entry),
// then reuse the webhook handler for lead matching + note creation.

const TLDV_LIST_URL = 'https://pasta.tldv.io/v1alpha1/meetings';
const POLL_PAGE_SIZE = 50;

// Default workspace — matches the calcom webhook fallback already in use.
const DEFAULT_WORKSPACE_ID =
  process.env.DEFAULT_WORKSPACE_ID ?? 'dd98a860-76dd-4b80-b136-41d41be170b3';

@Injectable()
export class TldvPollerService {
  private readonly logger = new Logger(TldvPollerService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tldvService: TldvService,
    private readonly tldvWebhookService: TldvWebhookService,
  ) {}

  @Cron(CronExpression.EVERY_10_MINUTES, { name: 'tldv-poll' })
  async pollMeetings(): Promise<void> {
    const apiKey = process.env.TLDV_API_KEY;

    if (!apiKey) {
      return;
    }

    try {
      const response = await fetch(
        `${TLDV_LIST_URL}?page=1&pageSize=${POLL_PAGE_SIZE}`,
        {
          method: 'GET',
          headers: { 'x-api-key': apiKey, Accept: 'application/json' },
          signal: AbortSignal.timeout(20_000),
        },
      );

      if (!response.ok) {
        this.logger.warn(`TLDV list failed: ${response.status}`);

        return;
      }

      const json = (await response.json()) as {
        results?: Array<{ id: string; name: string; happenedAt: string }>;
      };
      const meetings = json.results ?? [];

      if (meetings.length === 0) return;

      const alreadyProcessed = await this.findAlreadyProcessedMeetingIds(
        meetings.map((m) => m.id),
      );

      const toProcess = meetings.filter((m) => !alreadyProcessed.has(m.id));

      if (toProcess.length === 0) {
        return;
      }

      this.logger.log(
        `TLDV poll: ${meetings.length} total, ${toProcess.length} new`,
      );

      for (const summary of toProcess) {
        // Fetch full meeting (list endpoint already includes invitees/organizer
        // but we use the detail endpoint in case fields differ).
        const full = await this.tldvService.getMeeting(summary.id);

        if (!full) continue;

        try {
          const result = await this.tldvWebhookService.handleMeetingReady(
            { event: 'MeetingReady', data: full },
            DEFAULT_WORKSPACE_ID,
          );

          if (result.handled) {
            this.logger.log(
              `TLDV ${full.id} → lead ${result.leadId} ("${full.name}")`,
            );
          } else if (!result.handled && result.reason === 'No matching lead') {
            // Record a sentinel timeline entry so we don't retry forever.
            // (Intentionally skipped — we still want to match if a lead is
            // created later and this meeting would then attach retroactively.)
          }
        } catch (error) {
          this.logger.error(
            `TLDV poll error for ${full.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(
        `TLDV poll error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async findAlreadyProcessedMeetingIds(
    meetingIds: string[],
  ): Promise<Set<string>> {
    if (meetingIds.length === 0) return new Set();

    const schema = getWorkspaceSchemaName(DEFAULT_WORKSPACE_ID);

    const rows = await this.dataSource.query(
      `SELECT DISTINCT (properties->>'tldvMeetingId') AS "mid"
       FROM "${schema}"."timelineActivity"
       WHERE name = 'lead.meeting_completed'
         AND properties->>'tldvMeetingId' = ANY($1::text[])`,
      [meetingIds],
    );

    return new Set(rows.map((r: { mid: string }) => r.mid).filter(Boolean));
  }
}
