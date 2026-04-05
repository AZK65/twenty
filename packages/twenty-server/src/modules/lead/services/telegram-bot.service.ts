import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// Telegram bot for Apptics Sales CRM.
//
// Commands:
//   /lead John Doe john@gmail.com +15551234567  — create a lead
//   /link                                        — link this group to the last created lead
//   /link <email>                                — link this group to a lead by email
//   /summary                                     — manually trigger conversation summary
//   /help                                        — show help
//
// Auto-summary: every 30 min, if new messages exist, summarizes with AI
// and updates the lead's notes + timeline.

const TELEGRAM_API = 'https://api.telegram.org/bot';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const SUMMARY_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

type TelegramMessage = {
  message_id: number;
  chat: { id: number; title?: string; type: string };
  from?: { id: number; first_name: string; last_name?: string; username?: string };
  text?: string;
  date: number;
};

type TelegramUpdate = {
  message?: TelegramMessage;
};

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);
  private summaryTimers = new Map<number, NodeJS.Timeout>();

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;

    if (!message?.text) return;

    const text = message.text.trim();
    const schema = this.getSchema();

    if (text.startsWith('/lead')) {
      await this.handleLeadCommand(message, schema);
    } else if (text.startsWith('/link')) {
      await this.handleLinkCommand(message, schema);
    } else if (text.startsWith('/summary')) {
      await this.handleSummaryCommand(message, schema);
    } else if (text.startsWith('/help') || text.startsWith('/start')) {
      await this.handleHelpCommand(message);
    } else {
      // Buffer all non-command messages for summarization
      await this.bufferMessage(message, schema);
    }
  }

  // --- COMMANDS ---

  private async handleLeadCommand(message: TelegramMessage, schema: string): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const text = message.text!.replace(/^\/lead(@\w+)?\s*/, '').trim();

    if (!text) {
      await this.sendReply(botToken, message.chat.id,
        '⚠️ Usage: /lead Name email phone\n\nExample: /lead John Doe john@gmail.com +15551234567',
        message.message_id);

      return;
    }

    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const email = emailMatch ? emailMatch[0] : '';
    const phoneMatch = text.match(/\+?[\d\s()-]{7,}/);
    const phone = phoneMatch ? phoneMatch[0].replace(/[\s()-]/g, '') : '';

    let name = text;

    if (emailMatch) name = name.replace(emailMatch[0], '');
    if (phoneMatch) name = name.replace(phoneMatch[0], '');
    name = name.trim().replace(/\s+/g, ' ');

    if (!name) {
      await this.sendReply(botToken, message.chat.id,
        '⚠️ At least a name is required.',
        message.message_id);

      return;
    }

    try {
      const leadId = await this.createLead(name, email, phone, message, schema);

      // Auto-link this group to the lead
      await this.linkGroupToLead(message.chat.id, message.chat.title ?? '', leadId, schema);

      await this.sendReply(botToken, message.chat.id,
        `✅ Lead added: *${name}*`,
        message.message_id);

      this.logger.log(`Telegram bot created lead "${name}" (${leadId})`);
    } catch (error) {
      this.logger.error(`Failed to create lead from Telegram: ${error instanceof Error ? error.message : String(error)}`);
      await this.sendReply(botToken, message.chat.id,
        `❌ Failed to create lead`,
        message.message_id);
    }
  }

  private async handleLinkCommand(message: TelegramMessage, schema: string): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const text = message.text!.replace(/^\/link(@\w+)?\s*/, '').trim();

    let leadId: string | null = null;
    let leadName: string = '';

    if (text) {
      // Link by email
      const result = await this.dataSource.query(
        `SELECT id, name FROM "${schema}"."lead" WHERE "emailsPrimaryEmail" = $1 LIMIT 1`,
        [text],
      );

      if (result[0]) {
        leadId = result[0].id;
        leadName = result[0].name;
      }
    } else {
      // Link to the most recent lead created from this chat
      const result = await this.dataSource.query(
        `SELECT "leadId" FROM "${schema}"."telegramGroupLead" WHERE "chatId" = $1 LIMIT 1`,
        [message.chat.id],
      );

      if (result[0]) {
        await this.sendReply(botToken, message.chat.id,
          '✅ This group is already linked to a lead.',
          message.message_id);

        return;
      }

      // Get the most recent lead
      const recent = await this.dataSource.query(
        `SELECT id, name FROM "${schema}"."lead" ORDER BY "createdAt" DESC LIMIT 1`,
      );

      if (recent[0]) {
        leadId = recent[0].id;
        leadName = recent[0].name;
      }
    }

    if (!leadId) {
      await this.sendReply(botToken, message.chat.id,
        '⚠️ No lead found. Use /link email@example.com or create a lead first with /lead',
        message.message_id);

      return;
    }

    await this.linkGroupToLead(message.chat.id, message.chat.title ?? '', leadId, schema);

    await this.sendReply(botToken, message.chat.id,
      `✅ Group linked to lead: *${leadName}*`,
      message.message_id);
  }

  private async handleSummaryCommand(message: TelegramMessage, schema: string): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const workspaceId = this.getWorkspaceId();

    await this.sendReply(botToken, message.chat.id, '⏳ Generating summary...', message.message_id);

    const summary = await this.generateAndSaveSummary(message.chat.id, schema, workspaceId);

    if (summary) {
      await this.sendReply(botToken, message.chat.id, `📋 *Summary updated*\n\n${summary}`, message.message_id);
    } else {
      await this.sendReply(botToken, message.chat.id, '⚠️ No new messages to summarize, or group not linked to a lead.', message.message_id);
    }
  }

  private async handleHelpCommand(message: TelegramMessage): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    await this.sendReply(botToken, message.chat.id,
      '🤖 *Apptics Sales CRM Bot*\n\n' +
      '*Commands:*\n' +
      '/lead Name email phone — Add a lead\n' +
      '/link email — Link this group to a lead\n' +
      '/summary — Generate conversation summary\n\n' +
      'All messages are auto-summarized every 30 min and saved to the CRM.',
      message.message_id);
  }

  // --- MESSAGE BUFFERING ---

  private async bufferMessage(message: TelegramMessage, schema: string): Promise<void> {
    const senderName = [message.from?.first_name, message.from?.last_name].filter(Boolean).join(' ') || 'Unknown';

    await this.dataSource.query(
      `INSERT INTO "${schema}"."telegramMessage" ("chatId", "chatTitle", "senderName", "senderUsername", "messageText", "createdAt")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        message.chat.id,
        message.chat.title ?? '',
        senderName,
        message.from?.username ?? '',
        message.text ?? '',
        new Date(message.date * 1000),
      ],
    );

    // Schedule auto-summary if not already scheduled
    this.scheduleAutoSummary(message.chat.id, schema);
  }

  private scheduleAutoSummary(chatId: number, schema: string): void {
    if (this.summaryTimers.has(chatId)) return;

    const timer = setTimeout(async () => {
      this.summaryTimers.delete(chatId);

      try {
        const workspaceId = this.getWorkspaceId();

        await this.generateAndSaveSummary(chatId, schema, workspaceId);
        this.logger.log(`Auto-summary completed for chat ${chatId}`);
      } catch (error) {
        this.logger.error(`Auto-summary failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }, SUMMARY_INTERVAL_MS);

    this.summaryTimers.set(chatId, timer);
  }

  // --- SUMMARY GENERATION ---

  private async generateAndSaveSummary(
    chatId: number,
    schema: string,
    workspaceId: string,
  ): Promise<string | null> {
    // Get the linked lead
    const groupLead = await this.dataSource.query(
      `SELECT "leadId" FROM "${schema}"."telegramGroupLead" WHERE "chatId" = $1`,
      [chatId],
    );

    if (!groupLead[0]) return null;

    const leadId = groupLead[0].leadId;

    // Get unsummarized messages
    const messages = await this.dataSource.query(
      `SELECT "senderName", "messageText", "createdAt"
       FROM "${schema}"."telegramMessage"
       WHERE "chatId" = $1 AND "summarized" = false
       ORDER BY "createdAt" ASC`,
      [chatId],
    );

    if (messages.length === 0) return null;

    // Get existing summary from lead notes
    const leadResult = await this.dataSource.query(
      `SELECT name, needs FROM "${schema}"."lead" WHERE id = $1`,
      [leadId],
    );

    const existingSummary = leadResult[0]?.needs ?? '';
    const leadName = leadResult[0]?.name ?? '';

    // Build conversation text
    const conversation = messages.map((m: { senderName: string; messageText: string; createdAt: string }) => {
      const time = new Date(m.createdAt).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
      });

      return `[${time}] ${m.senderName}: ${m.messageText}`;
    }).join('\n');

    // Generate summary with AI
    const summary = await this.callAI(leadName, existingSummary, conversation);

    if (!summary) return null;

    // Update lead notes
    await this.dataSource.query(
      `UPDATE "${schema}"."lead" SET needs = $1, "updatedAt" = NOW() WHERE id = $2`,
      [summary, leadId],
    );

    // Add timeline entry
    await this.logToTimeline(leadId, workspaceId, 'Conversation summary updated', summary);

    // Mark messages as summarized
    await this.dataSource.query(
      `UPDATE "${schema}"."telegramMessage" SET "summarized" = true WHERE "chatId" = $1 AND "summarized" = false`,
      [chatId],
    );

    // Update last summary time
    await this.dataSource.query(
      `UPDATE "${schema}"."telegramGroupLead" SET "lastSummaryAt" = NOW() WHERE "chatId" = $1`,
      [chatId],
    );

    return summary;
  }

  private async callAI(leadName: string, existingSummary: string, newConversation: string): Promise<string | null> {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) {
      this.logger.warn('OPENROUTER_API_KEY not set — skipping AI summary');

      return null;
    }

    const prompt = existingSummary
      ? `You are a CRM assistant. Below is the existing summary for lead "${leadName}", followed by new conversation messages from a Telegram group chat.

Update the summary to include the new information. Keep it concise and organized.

Include:
- Names of people in the conversation and what they discussed
- Key topics and decisions
- Action items with deadlines if mentioned
- Any important details about the lead/client

EXISTING SUMMARY:
${existingSummary}

NEW MESSAGES:
${newConversation}

Write the updated summary:`
      : `You are a CRM assistant. Below are conversation messages from a Telegram group chat about lead "${leadName}".

Create a concise summary. Include:
- Names of people in the conversation and what they discussed
- Key topics and decisions
- Action items with deadlines if mentioned
- Any important details about the lead/client

MESSAGES:
${newConversation}

Write the summary:`;

    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const result = await response.json() as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return result.choices?.[0]?.message?.content ?? null;
    } catch (error) {
      this.logger.error(`AI summary failed: ${error instanceof Error ? error.message : String(error)}`);

      return null;
    }
  }

  // --- HELPERS ---

  private async createLead(
    name: string,
    email: string,
    phone: string,
    message: TelegramMessage,
    schema: string,
  ): Promise<string> {
    const leadId = uuidv4();
    const telegramUser = message.from;
    const chatTitle = message.chat.title ?? 'Direct message';

    const needs = [
      `Added via Telegram by ${telegramUser?.first_name ?? ''} ${telegramUser?.last_name ?? ''}`.trim(),
      `Chat: ${chatTitle}`,
    ].join('\n');

    await this.dataSource.query(
      `INSERT INTO "${schema}"."lead" (
        "id", "name",
        "emailsPrimaryEmail", "emailsAdditionalEmails",
        "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
        "source", "sourceDetail", "needs",
        "stage", "priority", "enrichmentStatus",
        "position", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2,
        $3, '[]'::jsonb,
        $4, '', '', '[]'::jsonb,
        'TELEGRAM', $5, $6,
        'NEW', 'MEDIUM', 'NOT_ENRICHED',
        0, NOW(), NOW()
      )`,
      [
        leadId,
        name,
        email,
        phone,
        JSON.stringify({ source: 'Telegram', chat: chatTitle, addedBy: telegramUser?.username ?? telegramUser?.first_name }),
        needs,
      ],
    );

    return leadId;
  }

  private async linkGroupToLead(chatId: number, chatTitle: string, leadId: string, schema: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "${schema}"."telegramGroupLead" ("chatId", "chatTitle", "leadId")
       VALUES ($1, $2, $3)
       ON CONFLICT ("chatId") DO UPDATE SET "leadId" = $3, "chatTitle" = $2`,
      [chatId, chatTitle, leadId],
    );
  }

  private async logToTimeline(
    leadId: string,
    workspaceId: string,
    eventName: string,
    content: string,
  ): Promise<void> {
    const schema = getWorkspaceSchemaName(workspaceId);

    const metaResult = await this.dataSource.query(
      `SELECT id FROM core."objectMetadata" WHERE "nameSingular" = 'lead' AND "workspaceId" = $1 LIMIT 1`,
      [workspaceId],
    );

    if (!metaResult[0]) return;

    try {
      await this.dataSource.query(
        `INSERT INTO "${schema}"."timelineActivity" (
          "id", "happensAt", "name", "properties",
          "linkedRecordCachedName", "linkedRecordId", "linkedObjectMetadataId",
          "targetLeadId",
          "createdAt", "updatedAt", "position"
        ) VALUES (
          $1, NOW(), $2, $3,
          '', $4, $5,
          $4,
          NOW(), NOW(), 0
        )`,
        [
          uuidv4(),
          eventName,
          JSON.stringify({ summary: content, channel: 'Telegram' }),
          leadId,
          metaResult[0].id,
        ],
      );
    } catch (error) {
      this.logger.warn(`Failed to log timeline: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async sendReply(botToken: string, chatId: number, text: string, replyToMessageId: number): Promise<void> {
    try {
      await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          parse_mode: 'Markdown',
          reply_to_message_id: replyToMessageId,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      this.logger.warn(`Failed to send Telegram reply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getSchema(): string {
    return getWorkspaceSchemaName(this.getWorkspaceId());
  }

  private getWorkspaceId(): string {
    return process.env.DEFAULT_WORKSPACE_ID ?? 'dd98a860-76dd-4b80-b136-41d41be170b3';
  }
}
