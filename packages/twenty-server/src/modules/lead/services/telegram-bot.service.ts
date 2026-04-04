import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// Telegram bot for adding leads to the CRM from group chats.
//
// Commands:
//   /lead John Doe john@gmail.com +15551234567
//   /lead John Doe john@gmail.com
//   /lead John Doe
//
// The bot parses name, email, and phone from the message.
// Responds with confirmation in the group chat.
//
// Environment variable:
//   TELEGRAM_BOT_TOKEN — Bot token from BotFather

const TELEGRAM_API = 'https://api.telegram.org/bot';

type TelegramUpdate = {
  message?: {
    message_id: number;
    chat: { id: number; title?: string; type: string };
    from?: { id: number; first_name: string; last_name?: string; username?: string };
    text?: string;
    date: number;
  };
};

@Injectable()
export class TelegramBotService {
  private readonly logger = new Logger(TelegramBotService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;

    if (!message?.text) return;

    const text = message.text.trim();

    if (text.startsWith('/lead')) {
      await this.handleLeadCommand(message);
    } else if (text.startsWith('/help') || text.startsWith('/start')) {
      await this.handleHelpCommand(message);
    }
  }

  private async handleLeadCommand(message: TelegramUpdate['message']): Promise<void> {
    if (!message?.text) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    // Parse: /lead Name email phone
    // or: /lead@BotName Name email phone
    const text = message.text.replace(/^\/lead(@\w+)?\s*/, '').trim();

    if (!text) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ Usage: /lead Name email phone\n\nExamples:\n/lead John Doe john@gmail.com +15551234567\n/lead John Doe john@gmail.com\n/lead John Doe',
        message.message_id,
      );

      return;
    }

    // Extract email (anything with @)
    const emailMatch = text.match(/[\w.+-]+@[\w.-]+\.\w+/);
    const email = emailMatch ? emailMatch[0] : '';

    // Extract phone (anything starting with + or a sequence of digits)
    const phoneMatch = text.match(/\+?[\d\s()-]{7,}/);
    const phone = phoneMatch ? phoneMatch[0].replace(/[\s()-]/g, '') : '';

    // Name is everything that's not the email or phone
    let name = text;

    if (emailMatch) name = name.replace(emailMatch[0], '');
    if (phoneMatch) name = name.replace(phoneMatch[0], '');
    name = name.trim().replace(/\s+/g, ' ');

    if (!name) {
      await this.sendReply(
        botToken,
        message.chat.id,
        '⚠️ At least a name is required.\n\nUsage: /lead John Doe john@gmail.com +15551234567',
        message.message_id,
      );

      return;
    }

    const workspaceId = process.env.DEFAULT_WORKSPACE_ID
      ?? 'dd98a860-76dd-4b80-b136-41d41be170b3';

    try {
      const leadId = await this.createLead(name, email, phone, message, workspaceId);

      const parts = [`✅ Lead created: *${name}*`];

      if (email) parts.push(`📧 ${email}`);
      if (phone) parts.push(`📱 ${phone}`);
      parts.push(`\n🔗 [View in CRM](https://crm.apptics.pro/objects/lead/${leadId})`);

      await this.sendReply(
        botToken,
        message.chat.id,
        parts.join('\n'),
        message.message_id,
      );

      this.logger.log(
        `Telegram bot created lead "${name}" (${leadId}) from chat "${message.chat.title ?? message.chat.id}"`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to create lead from Telegram: ${error instanceof Error ? error.message : String(error)}`,
      );

      await this.sendReply(
        botToken,
        message.chat.id,
        `❌ Failed to create lead: ${error instanceof Error ? error.message : 'Unknown error'}`,
        message.message_id,
      );
    }
  }

  private async handleHelpCommand(message: TelegramUpdate['message']): Promise<void> {
    if (!message) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;

    if (!botToken) return;

    await this.sendReply(
      botToken,
      message.chat.id,
      '🤖 *Apptics Sales CRM Bot*\n\n' +
      'Add leads to the CRM directly from Telegram.\n\n' +
      '*Commands:*\n' +
      '/lead John Doe john@gmail.com +15551234567\n' +
      '/lead John Doe john@gmail.com\n' +
      '/lead John Doe\n\n' +
      'The lead will appear in the CRM under Meeting Scheduled.',
      message.message_id,
    );
  }

  private async createLead(
    name: string,
    email: string,
    phone: string,
    message: TelegramUpdate['message'],
    workspaceId: string,
  ): Promise<string> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const leadId = uuidv4();

    const nameParts = name.split(' ');
    const telegramUser = message?.from;
    const chatTitle = message?.chat?.title ?? 'Direct message';

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
        'OTHER', $5, $6,
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
}
