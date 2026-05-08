import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { TelegramFollowupService } from 'src/modules/lead/services/telegram-followup.service';
import { TelegramLeadOpsService } from 'src/modules/lead/services/telegram-lead-ops.service';
import { TelegramQAService } from 'src/modules/lead/services/telegram-qa.service';

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
  from?: {
    id: number;
    first_name: string;
    last_name?: string;
    username?: string;
  };
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
    private readonly followupService: TelegramFollowupService,
    private readonly leadOpsService: TelegramLeadOpsService,
    private readonly qaService: TelegramQAService,
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
    } else if (text.startsWith('/myid')) {
      await this.handleMyIdCommand(message);
    } else if (text.startsWith('/followup')) {
      await this.handleFollowupCommand(message, schema);
    } else if (text.startsWith('/note')) {
      await this.handleNoteCommand(message, schema);
    } else if (text.startsWith('/stage')) {
      await this.handleStageCommand(message, schema);
    } else if (text.startsWith('/priority')) {
      await this.handlePriorityCommand(message, schema);
    } else if (text.startsWith('/value')) {
      await this.handleValueCommand(message, schema);
    } else if (text.startsWith('/assign')) {
      await this.handleAssignCommand(message, schema);
    } else if (text.startsWith('/task')) {
      await this.handleTaskCommand(message, schema);
    } else if (text.startsWith('/info')) {
      await this.handleInfoCommand(message, schema);
    } else if (text.startsWith('/ask')) {
      await this.handleAskCommand(message, schema);
    } else if (message.chat.type === 'private') {
      // In DMs from admins, treat any non-command message as a Q&A question.
      if (this.isAdmin(message.chat.id)) {
        await this.handleAskCommand(message, schema, /* alreadyTrimmed */ true);
      }
    } else {
      // Auto-link group to lead if not linked yet
      await this.tryAutoLink(message, schema);
      // Buffer all non-command messages for summarization
      await this.bufferMessage(message, schema);
    }
  }

  private isAdmin(chatId: number): boolean {
    const raw = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (!raw) return false;

    return raw
      .split(',')
      .map((id) => id.trim())
      .includes(String(chatId));
  }

  // --- COMMANDS ---

  private async handleLeadCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const text = message.text!.replace(/^\/lead(@\w+)?\s*/, '').trim();

    if (!text) {
      await this.notifyAdmin(
        botToken,
        '⚠️ /lead used without details. Usage: /lead Name email phone',
      );

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
      await this.notifyAdmin(botToken, '⚠️ /lead needs at least a name.');

      return;
    }

    try {
      const leadId = await this.createLead(name, email, phone, message, schema);

      // Auto-link this group to the lead
      await this.linkGroupToLead(
        message.chat.id,
        message.chat.title ?? '',
        leadId,
        schema,
      );

      await this.notifyAdmin(
        botToken,
        `✅ Lead added: *${name}*\nFrom group: ${message.chat.title ?? 'DM'}`,
      );

      this.logger.log(`Telegram bot created lead "${name}" (${leadId})`);
    } catch (error) {
      this.logger.error(
        `Failed to create lead from Telegram: ${error instanceof Error ? error.message : String(error)}`,
      );
      await this.notifyAdmin(
        botToken,
        `❌ Failed to create lead from group: ${message.chat.title ?? 'DM'}`,
      );
    }
  }

  private async handleLinkCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
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
        await this.sendReply(
          botToken,
          message.chat.id,
          '✅ This group is already linked to a lead.',
          message.message_id,
        );

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
      await this.notifyAdmin(
        botToken,
        `⚠️ No lead found to link group: ${message.chat.title ?? 'Unknown'}`,
      );

      return;
    }

    await this.linkGroupToLead(
      message.chat.id,
      message.chat.title ?? '',
      leadId,
      schema,
    );

    await this.notifyAdmin(
      botToken,
      `🔗 Group linked: *${message.chat.title ?? 'Unknown'}* → lead: *${leadName}*`,
    );
  }

  private async handleSummaryCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const workspaceId = this.getWorkspaceId();

    const summary = await this.generateAndSaveSummary(
      message.chat.id,
      schema,
      workspaceId,
    );

    if (summary) {
      await this.notifyAdmin(
        botToken,
        `📋 *Summary updated* for ${message.chat.title ?? 'group'}\n\n${summary}`,
      );
    } else {
      await this.notifyAdmin(
        botToken,
        `⚠️ No new messages to summarize for ${message.chat.title ?? 'group'}`,
      );
    }
  }

  private async handleMyIdCommand(message: TelegramMessage): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const userName =
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(' ') || 'unknown';

    await this.sendReply(
      botToken,
      message.chat.id,
      `🆔 *Your chat ID:* \`${message.chat.id}\`\n*User:* ${userName}\n\nSend this to your admin to get added to CRM notifications.`,
      message.message_id,
    );
  }

  private async handleHelpCommand(message: TelegramMessage): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    await this.sendReply(
      botToken,
      message.chat.id,
      '🤖 *Apptics Sales CRM Bot*\n\n' +
        '*Lead capture*\n' +
        '/lead Name email phone — Add a lead\n' +
        '/link [email] — Link this group to a lead\n\n' +
        '*Manage the linked lead*\n' +
        '/info — Show key fields\n' +
        '/note <text> — Add a note\n' +
        '/stage WON — Change stage\n' +
        '/priority HIGH — Set priority\n' +
        '/value 5000 USD — Estimated deal value\n' +
        '/assign <name> — Assign to a workspace member\n' +
        '/task <title> [due:tomorrow] — Add a task\n\n' +
        '*Follow-ups (bot @-mentions client at scheduled time)*\n' +
        '/followup tomorrow 10am — check on proposal\n' +
        '/followup list\n' +
        '/followup cancel <n>\n\n' +
        '*Conversations*\n' +
        '/summary — Force AI summary now (auto every 30 min)\n\n' +
        '*AI Q&A (admins)*\n' +
        '/ask <question>  (or just message the bot in DM)\n' +
        'e.g. "What\'s the status of John Doe?"\n\n' +
        '/myid — Show your chat ID',
      message.message_id,
    );
  }

  // --- AUTO-LINKING ---

  private async tryAutoLink(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    if (!message.chat.title || message.chat.type === 'private') return;

    // Check if already linked
    const existing = await this.dataSource.query(
      `SELECT "leadId" FROM "${schema}"."telegramGroupLead" WHERE "chatId" = $1`,
      [message.chat.id],
    );

    if (existing.length > 0) return;

    // Try to match group name to a lead name
    // Group names like "John Doe - Apptics", "Jake | Onboarding", "Antoine Le Brun"
    // Strip common suffixes and try matching
    const groupName = message.chat.title;
    const cleanedNames = this.extractNamesFromGroupTitle(groupName);

    for (const name of cleanedNames) {
      if (name.length < 3) continue;

      const results = await this.dataSource.query(
        `SELECT id, name FROM "${schema}"."lead"
         WHERE LOWER(name) = LOWER($1)
         OR LOWER(name) LIKE LOWER($2)
         LIMIT 1`,
        [name, `${name}%`],
      );

      if (results[0]) {
        await this.linkGroupToLead(
          message.chat.id,
          groupName,
          results[0].id,
          schema,
        );

        this.logger.log(
          `Auto-linked group "${groupName}" to lead "${results[0].name}" (matched: "${name}")`,
        );

        return;
      }
    }
  }

  private extractNamesFromGroupTitle(title: string): string[] {
    // Remove common separators and extract potential names
    // "John Doe - Apptics" → ["John Doe"]
    // "Jake | Onboarding" → ["Jake"]
    // "finity & Apptics Sales CRM, AKZ" → ["finity", "AKZ"]
    const names: string[] = [];

    // Split by common separators
    const parts = title.split(/[-|&,/\\•·]+/).map((p) => p.trim());

    for (const part of parts) {
      // Skip known non-name parts
      const lower = part.toLowerCase();

      if (
        lower.includes('apptics') ||
        lower.includes('crm') ||
        lower.includes('onboarding') ||
        lower.includes('sales') ||
        lower.includes('support') ||
        lower.includes('team') ||
        lower.includes('bot') ||
        lower.includes('group')
      ) {
        continue;
      }

      if (part.length >= 2) {
        names.push(part);
      }
    }

    // Also try the full title as-is (for groups named just "John Doe")
    if (names.length === 0) {
      names.push(title.trim());
    }

    return names;
  }

  // --- LEAD-OPS COMMANDS ---

  // Resolves the lead this command targets:
  //   • In a group chat → the group's linked lead.
  //   • In a DM → an explicit `lead:<email>` token, or the most recent lead.
  // Returns null if nothing is linked AND no email was supplied.
  private async resolveTargetLead(
    message: TelegramMessage,
    schema: string,
    explicitEmail: string | null,
  ): Promise<{ leadId: string; leadName: string } | null> {
    if (explicitEmail) {
      return this.leadOpsService.findLeadByEmail(schema, explicitEmail);
    }

    if (message.chat.type !== 'private') {
      return this.leadOpsService.resolveLeadFromChat(schema, message.chat.id);
    }

    // DM with no email: most recent lead as fallback
    const recent = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE "deletedAt" IS NULL
       ORDER BY "createdAt" DESC LIMIT 1`,
    );

    if (!recent[0]) return null;

    return { leadId: recent[0].id, leadName: recent[0].name };
  }

  // Pulls "lead:foo@bar.com" or "@username" tokens out of a command body and
  // returns the cleaned remainder.
  private extractTokens(body: string): {
    email: string | null;
    mentionUsername: string | null;
    rest: string;
  } {
    let email: string | null = null;
    let mentionUsername: string | null = null;
    let rest = body;

    const emailMatch = rest.match(/lead:([\w.+-]+@[\w.-]+\.\w+)/i);

    if (emailMatch) {
      email = emailMatch[1];
      rest = rest.replace(emailMatch[0], '').trim();
    }

    const mentionMatch = rest.match(/(^|\s)@(\w+)\b/);

    if (mentionMatch) {
      mentionUsername = mentionMatch[2];
      rest = rest.replace(mentionMatch[0], ' ').trim();
    }

    return { email, mentionUsername, rest };
  }

  private async handleFollowupCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/followup(@\w+)?\s*/, '').trim();

    // Subcommands
    if (body === 'list' || body.startsWith('list ')) {
      const lead = await this.resolveTargetLead(message, schema, null);

      if (!lead) {
        await this.sendReply(
          botToken,
          message.chat.id,
          '⚠️ No lead linked.',
          message.message_id,
        );
        return;
      }

      const items = await this.followupService.listForLead(schema, lead.leadId);

      if (items.length === 0) {
        await this.sendReply(
          botToken,
          message.chat.id,
          `No pending follow-ups for *${lead.leadName}*.`,
          message.message_id,
        );
        return;
      }

      const lines = items.map((it, i) => {
        const at = new Date(it.fireAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        });
        const handle = it.mentionUsername ? `@${it.mentionUsername} ` : '';
        return `${i + 1}. *${at}* — ${handle}${it.message}`;
      });

      await this.sendReply(
        botToken,
        message.chat.id,
        `📅 Follow-ups for *${lead.leadName}*:\n${lines.join('\n')}`,
        message.message_id,
      );
      return;
    }

    if (body.startsWith('cancel')) {
      const m = body.match(/cancel\s+(\d+)/);
      if (!m) {
        await this.sendReply(
          botToken,
          message.chat.id,
          'Usage: `/followup cancel <n>`',
          message.message_id,
        );
        return;
      }
      const lead = await this.resolveTargetLead(message, schema, null);
      if (!lead) {
        await this.sendReply(
          botToken,
          message.chat.id,
          '⚠️ No lead linked.',
          message.message_id,
        );
        return;
      }
      const cancelled = await this.followupService.cancelByIndex(
        schema,
        lead.leadId,
        parseInt(m[1], 10),
      );
      await this.sendReply(
        botToken,
        message.chat.id,
        cancelled
          ? `❌ Cancelled follow-up: ${cancelled.message}`
          : '⚠️ No follow-up at that index.',
        message.message_id,
      );
      return;
    }

    // Schedule
    const tokens = this.extractTokens(body);
    let { rest, mentionUsername } = tokens;
    let messageText = '';
    let whenText = rest;

    // Split on "—", "--", or " - " to separate time from message
    const sepMatch = rest.match(/\s+(?:—|--|-)\s+/);

    if (sepMatch) {
      whenText = rest.slice(0, sepMatch.index!).trim();
      messageText = rest.slice(sepMatch.index! + sepMatch[0].length).trim();
    }

    if (!whenText) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/followup tomorrow 10am — check on proposal`',
        message.message_id,
      );
      return;
    }

    const fireAt = this.followupService.parseWhen(whenText);

    if (!fireAt) {
      await this.sendReply(
        botToken,
        message.chat.id,
        `⚠️ Could not parse time "${whenText}". Try: "tomorrow 10am", "in 3 days", "friday 2pm".`,
        message.message_id,
      );
      return;
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked to this chat. Use `/link` or include `lead:email@domain.com`.',
        message.message_id,
      );
      return;
    }

    // Auto-fill mention from buffered messages if none provided
    if (!mentionUsername && message.chat.type !== 'private') {
      try {
        const lastClient = await this.dataSource.query(
          `SELECT "senderUsername" FROM "${schema}"."telegramMessage"
           WHERE "chatId" = $1 AND "senderUsername" <> '' AND "senderUsername" IS NOT NULL
           ORDER BY "createdAt" DESC LIMIT 1`,
          [message.chat.id],
        );
        if (lastClient[0]?.senderUsername) {
          mentionUsername = lastClient[0].senderUsername;
        }
      } catch {
        // ignore
      }
    }

    if (!messageText) {
      messageText = `Hi${lead.leadName ? ` ${lead.leadName.split(' ')[0]}` : ''} — anything we need from you?`;
    }

    await this.followupService.schedule({
      schema,
      chatId: message.chat.id,
      chatTitle: message.chat.title ?? '',
      leadId: lead.leadId,
      fireAt,
      message: messageText,
      mentionUsername,
      createdByUsername: message.from?.username ?? null,
    });

    const at = fireAt.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    await this.sendReply(
      botToken,
      message.chat.id,
      `📅 Scheduled follow-up for *${lead.leadName}* at *${at}*\n${
        mentionUsername ? `Will mention @${mentionUsername}\n` : ''
      }Message: ${messageText}`,
      message.message_id,
    );
  }

  private async handleNoteCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/note(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);

    if (!tokens.rest) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/note <text>`',
        message.message_id,
      );
      return;
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked. Use `/link` first.',
        message.message_id,
      );
      return;
    }

    const workspaceId = this.getWorkspaceId();
    const senderName =
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(' ') || 'Telegram';
    const title = `Note from ${senderName}`;

    await this.leadOpsService.addNote(
      schema,
      workspaceId,
      lead.leadId,
      title,
      tokens.rest,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      `📝 Note added to *${lead.leadName}*.`,
      message.message_id,
    );
  }

  private async handleStageCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/stage(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);

    if (!tokens.rest) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/stage WON`',
        message.message_id,
      );
      return;
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    const result = await this.leadOpsService.setStage(
      schema,
      this.getWorkspaceId(),
      lead.leadId,
      tokens.rest,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      result.ok
        ? `✅ Stage of *${lead.leadName}* → *${tokens.rest.toUpperCase()}*`
        : `⚠️ ${result.reason}`,
      message.message_id,
    );
  }

  private async handlePriorityCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/priority(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);

    if (!tokens.rest) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/priority HIGH`',
        message.message_id,
      );
      return;
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    const result = await this.leadOpsService.setPriority(
      schema,
      this.getWorkspaceId(),
      lead.leadId,
      tokens.rest,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      result.ok
        ? `✅ Priority of *${lead.leadName}* → *${tokens.rest.toUpperCase()}*`
        : `⚠️ ${result.reason}`,
      message.message_id,
    );
  }

  private async handleValueCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/value(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);
    const m = tokens.rest.match(/([\d,.]+)\s*([A-Za-z]{3})?/);

    if (!m) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/value 5000 USD`',
        message.message_id,
      );
      return;
    }

    const amount = parseFloat(m[1].replace(/,/g, ''));
    const currency = (m[2] ?? 'USD').toUpperCase();

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    const result = await this.leadOpsService.setValue(
      schema,
      this.getWorkspaceId(),
      lead.leadId,
      amount,
      currency,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      result.ok
        ? `💰 Value of *${lead.leadName}* set to *${amount.toLocaleString()} ${currency}*`
        : `⚠️ ${result.reason}`,
      message.message_id,
    );
  }

  private async handleAssignCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/assign(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);

    if (!tokens.rest) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/assign <name>`',
        message.message_id,
      );
      return;
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    const result = await this.leadOpsService.assignTo(
      schema,
      this.getWorkspaceId(),
      lead.leadId,
      tokens.rest,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      result.ok
        ? `👤 *${lead.leadName}* assigned to *${result.memberName}*`
        : `⚠️ ${result.reason}`,
      message.message_id,
    );
  }

  private async handleTaskCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/task(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);

    if (!tokens.rest) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Usage: `/task <title> [due:tomorrow]`',
        message.message_id,
      );
      return;
    }

    let title = tokens.rest;
    let dueAt: Date | null = null;

    const dueMatch = title.match(/\bdue:\s*([^,]+?)$/i);

    if (dueMatch) {
      title = title.slice(0, dueMatch.index).trim();
      dueAt = this.followupService.parseWhen(dueMatch[1].trim());
    }

    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    await this.leadOpsService.addTask(
      schema,
      this.getWorkspaceId(),
      lead.leadId,
      title,
      dueAt,
      null,
    );

    await this.sendReply(
      botToken,
      message.chat.id,
      `✅ Task added to *${lead.leadName}*: ${title}${dueAt ? ` (due ${dueAt.toLocaleDateString()})` : ''}`,
      message.message_id,
    );
  }

  private async handleInfoCommand(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    const body = message.text!.replace(/^\/info(@\w+)?\s*/, '').trim();
    const tokens = this.extractTokens(body);
    const lead = await this.resolveTargetLead(message, schema, tokens.email);

    if (!lead) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ No lead linked.',
        message.message_id,
      );
      return;
    }

    const info = await this.leadOpsService.getInfo(schema, lead.leadId);

    if (!info) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ Lead not found.',
        message.message_id,
      );
      return;
    }

    const lines = [
      `*${info.name}*`,
      `Stage: ${info.stage ?? '—'}    Priority: ${info.priority ?? '—'}`,
      `Source: ${info.source ?? '—'}`,
      info.estimatedValue ? `Value: ${info.estimatedValue}` : null,
      info.nextFollowUpDate
        ? `Next follow-up: ${new Date(info.nextFollowUpDate).toLocaleString()}`
        : null,
      info.assignedToName ? `Assigned: ${info.assignedToName}` : null,
      info.primaryEmail ? `Email: ${info.primaryEmail}` : null,
      info.primaryPhone ? `Phone: ${info.primaryPhone}` : null,
      info.needs ? `\nNeeds:\n${info.needs}` : null,
    ].filter(Boolean);

    await this.sendReply(
      botToken,
      message.chat.id,
      lines.join('\n'),
      message.message_id,
    );
  }

  private async handleAskCommand(
    message: TelegramMessage,
    schema: string,
    alreadyTrimmed: boolean = false,
  ): Promise<void> {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    if (!this.isAdmin(message.chat.id)) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '🔒 Q&A is restricted to admin users. Contact your admin to be added.',
        message.message_id,
      );
      return;
    }

    const question = alreadyTrimmed
      ? message.text!.trim()
      : message.text!.replace(/^\/ask(@\w+)?\s*/, '').trim();

    if (!question) {
      await this.sendReply(
        botToken,
        message.chat.id,
        'Ask me anything about your CRM. e.g. "What is the status of John Doe?"',
        message.message_id,
      );
      return;
    }

    if (!this.qaService.isConfigured()) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ AI is not configured (OPENROUTER_API_KEY missing).',
        message.message_id,
      );
      return;
    }

    // Send a typing indicator to set expectation
    try {
      await fetch(`${TELEGRAM_API}${botToken}/sendChatAction`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: message.chat.id, action: 'typing' }),
        signal: AbortSignal.timeout(5_000),
      });
    } catch {
      // ignore
    }

    const answer = await this.qaService.answer(question, schema);

    await this.sendReply(botToken, message.chat.id, answer, message.message_id);
  }

  // --- MESSAGE BUFFERING ---

  private async bufferMessage(
    message: TelegramMessage,
    schema: string,
  ): Promise<void> {
    const senderName =
      [message.from?.first_name, message.from?.last_name]
        .filter(Boolean)
        .join(' ') || 'Unknown';

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
        this.logger.error(
          `Auto-summary failed for chat ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
        );
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
    const conversation = messages
      .map(
        (m: { senderName: string; messageText: string; createdAt: string }) => {
          const time = new Date(m.createdAt).toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: 'numeric',
            minute: '2-digit',
            hour12: true,
          });

          return `[${time}] ${m.senderName}: ${m.messageText}`;
        },
      )
      .join('\n');

    // Generate summary with AI
    const summary = await this.callAI(leadName, existingSummary, conversation);

    if (!summary) return null;

    // Update lead notes
    await this.dataSource.query(
      `UPDATE "${schema}"."lead" SET needs = $1, "updatedAt" = NOW() WHERE id = $2`,
      [summary, leadId],
    );

    // Add timeline entry
    await this.logToTimeline(
      leadId,
      workspaceId,
      'Conversation summary updated',
      summary,
    );

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

  private async callAI(
    leadName: string,
    existingSummary: string,
    newConversation: string,
  ): Promise<string | null> {
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
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 1000,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const result = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };

      return result.choices?.[0]?.message?.content ?? null;
    } catch (error) {
      this.logger.error(
        `AI summary failed: ${error instanceof Error ? error.message : String(error)}`,
      );

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
        JSON.stringify({
          source: 'Telegram',
          chat: chatTitle,
          addedBy: telegramUser?.username ?? telegramUser?.first_name,
        }),
        needs,
      ],
    );

    return leadId;
  }

  private async linkGroupToLead(
    chatId: number,
    chatTitle: string,
    leadId: string,
    schema: string,
  ): Promise<void> {
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
      this.logger.warn(
        `Failed to log timeline: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async notifyAdmin(botToken: string, text: string): Promise<void> {
    // Supports a single chat ID or comma-separated list:
    //   TELEGRAM_ADMIN_CHAT_ID=1637955920
    //   TELEGRAM_ADMIN_CHAT_ID=1637955920,9876543210
    const raw = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (!raw) return;

    const chatIds = raw
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0);

    await Promise.all(
      chatIds.map(async (chatId) => {
        try {
          await fetch(`${TELEGRAM_API}${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              chat_id: chatId,
              text,
              parse_mode: 'Markdown',
            }),
            signal: AbortSignal.timeout(10_000),
          });
        } catch (error) {
          this.logger.warn(
            `Failed to notify admin ${chatId}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }),
    );
  }

  private async sendReply(
    botToken: string,
    chatId: number,
    text: string,
    replyToMessageId: number,
  ): Promise<void> {
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
      this.logger.warn(
        `Failed to send Telegram reply: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getSchema(): string {
    return getWorkspaceSchemaName(this.getWorkspaceId());
  }

  private getWorkspaceId(): string {
    return (
      process.env.DEFAULT_WORKSPACE_ID ?? 'dd98a860-76dd-4b80-b136-41d41be170b3'
    );
  }
}
