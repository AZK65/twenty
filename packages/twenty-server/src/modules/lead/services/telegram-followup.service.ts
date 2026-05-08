import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import * as chrono from 'chrono-node';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

const TELEGRAM_API = 'https://api.telegram.org/bot';
const POLL_INTERVAL_MS = 60 * 1000; // 1 min

type FollowupRow = {
  id: string;
  chatId: string;
  leadId: string | null;
  fireAt: Date;
  message: string;
  mentionUsername: string | null;
  cancelled: boolean;
  sentAt: Date | null;
};

@Injectable()
export class TelegramFollowupService implements OnModuleInit {
  private readonly logger = new Logger(TelegramFollowupService.name);
  private pollTimer: NodeJS.Timeout | null = null;

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.DISABLE_TELEGRAM_FOLLOWUP_POLLER === 'true') return;

    try {
      await this.bootstrapTable();
    } catch (error) {
      this.logger.warn(
        `Could not bootstrap follow-up table: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.pollTimer = setInterval(
      () =>
        this.pollDueFollowups().catch((e) => this.logger.warn(`poll: ${e}`)),
      POLL_INTERVAL_MS,
    );

    // .unref() so the timer never keeps the Node event loop alive on its own.
    // Critical: the entrypoint runs `yarn command:prod upgrade` which loads
    // this module, fires onModuleInit, completes, and tries to exit. Without
    // unref, the interval would hold the process open forever and the deploy
    // would hang.
    this.pollTimer.unref?.();
  }

  // Schema is per-workspace, so we can't pre-create at boot. Bootstrap
  // lazily inside each workspace schema when first used.
  private bootstrapped = new Set<string>();

  private async bootstrapTable(schema?: string): Promise<void> {
    if (!schema) return;
    if (this.bootstrapped.has(schema)) return;

    await this.dataSource.query(`
      CREATE TABLE IF NOT EXISTS "${schema}"."telegramScheduledFollowup" (
        "id" UUID PRIMARY KEY,
        "chatId" BIGINT NOT NULL,
        "chatTitle" TEXT,
        "leadId" UUID,
        "fireAt" TIMESTAMP WITH TIME ZONE NOT NULL,
        "message" TEXT NOT NULL,
        "mentionUsername" TEXT,
        "createdByUsername" TEXT,
        "cancelled" BOOLEAN NOT NULL DEFAULT FALSE,
        "sentAt" TIMESTAMP WITH TIME ZONE,
        "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
      )
    `);
    await this.dataSource.query(
      `CREATE INDEX IF NOT EXISTS "telegramScheduledFollowup_due_idx"
       ON "${schema}"."telegramScheduledFollowup" ("fireAt")
       WHERE "sentAt" IS NULL AND "cancelled" = FALSE`,
    );
    this.bootstrapped.add(schema);
  }

  // --- PUBLIC API ---

  async schedule(args: {
    schema: string;
    chatId: number;
    chatTitle: string;
    leadId: string | null;
    fireAt: Date;
    message: string;
    mentionUsername: string | null;
    createdByUsername: string | null;
  }): Promise<{ id: string }> {
    await this.bootstrapTable(args.schema);

    const id = uuidv4();

    await this.dataSource.query(
      `INSERT INTO "${args.schema}"."telegramScheduledFollowup"
       ("id","chatId","chatTitle","leadId","fireAt","message","mentionUsername","createdByUsername")
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        args.chatId,
        args.chatTitle,
        args.leadId,
        args.fireAt.toISOString(),
        args.message,
        args.mentionUsername,
        args.createdByUsername,
      ],
    );

    if (args.leadId) {
      try {
        await this.dataSource.query(
          `UPDATE "${args.schema}"."lead"
           SET "nextFollowUpDate" = $1, "updatedAt" = NOW()
           WHERE id = $2`,
          [args.fireAt.toISOString(), args.leadId],
        );
      } catch (error) {
        this.logger.warn(
          `Failed to update lead.nextFollowUpDate: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { id };
  }

  async listForLead(schema: string, leadId: string): Promise<FollowupRow[]> {
    await this.bootstrapTable(schema);

    return this.dataSource.query(
      `SELECT * FROM "${schema}"."telegramScheduledFollowup"
       WHERE "leadId" = $1 AND "sentAt" IS NULL AND "cancelled" = FALSE
       ORDER BY "fireAt" ASC`,
      [leadId],
    );
  }

  async cancelByIndex(
    schema: string,
    leadId: string,
    nthOneBased: number,
  ): Promise<FollowupRow | null> {
    const pending = await this.listForLead(schema, leadId);
    const target = pending[nthOneBased - 1];

    if (!target) return null;

    await this.dataSource.query(
      `UPDATE "${schema}"."telegramScheduledFollowup"
       SET "cancelled" = TRUE
       WHERE id = $1`,
      [target.id],
    );

    return target;
  }

  // --- DATE PARSING ---

  parseWhen(text: string): Date | null {
    const result = chrono.parseDate(text, new Date(), { forwardDate: true });

    if (!result) return null;
    if (result.getTime() <= Date.now()) return null;

    return result;
  }

  // --- POLLER ---

  private async pollDueFollowups(): Promise<void> {
    const schemas = Array.from(this.bootstrapped);

    if (schemas.length === 0) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    for (const schema of schemas) {
      let due: FollowupRow[] = [];

      try {
        due = await this.dataSource.query(
          `SELECT * FROM "${schema}"."telegramScheduledFollowup"
           WHERE "sentAt" IS NULL AND "cancelled" = FALSE AND "fireAt" <= NOW()
           ORDER BY "fireAt" ASC LIMIT 50`,
        );
      } catch {
        continue;
      }

      for (const row of due) {
        const text = row.mentionUsername
          ? `@${row.mentionUsername.replace(/^@/, '')} ${row.message}`
          : row.message;

        try {
          await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: row.chatId,
              text,
            }),
            signal: AbortSignal.timeout(10_000),
          });

          await this.dataSource.query(
            `UPDATE "${schema}"."telegramScheduledFollowup"
             SET "sentAt" = NOW() WHERE id = $1`,
            [row.id],
          );

          this.logger.log(
            `Sent scheduled follow-up ${row.id} to chat ${row.chatId}`,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to send follow-up ${row.id}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
}
