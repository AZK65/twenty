import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// Sendblue iMessage integration.
// Sends an auto-welcome iMessage when a lead books a call,
// and handles inbound "reschedule" replies.
//
// Environment variables:
//   SENDBLUE_API_KEY     — Sendblue API key ID
//   SENDBLUE_API_SECRET  — Sendblue API secret
//   SENDBLUE_FROM_NUMBER — Your Sendblue phone number (E.164)
//   SENDBLUE_WEBHOOK_URL — (set in Sendblue dashboard) inbound message webhook

const SENDBLUE_API_URL = 'https://api.sendblue.co/api/send-message';
const RESCHEDULE_URL = 'https://cal.com/team/apptics/intro';

type SendblueResponse = {
  message_handle?: string;
  status?: string;
  error_message?: string;
};

@Injectable()
export class SendblueService {
  private readonly logger = new Logger(SendblueService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async sendCallBookedMessage(
    leadId: string,
    leadName: string,
    phoneNumber: string,
    callTime: string,
    workspaceId: string,
  ): Promise<SendblueResponse | null> {
    const apiKey = process.env.SENDBLUE_API_KEY;
    const apiSecret = process.env.SENDBLUE_API_SECRET;
    const fromNumber = process.env.SENDBLUE_FROM_NUMBER;

    if (!apiKey || !apiSecret || !fromNumber) {
      this.logger.debug('Sendblue not configured — skipping iMessage');

      return null;
    }

    if (!phoneNumber) {
      this.logger.debug(`No phone number for lead ${leadId} — skipping iMessage`);

      return null;
    }

    const firstName = leadName.split(' ')[0] || 'there';
    const callDate = new Date(callTime);
    const formattedDate = callDate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    });
    const formattedTime = callDate.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const message =
      `Hey ${firstName}! Thanks for booking your intro call with Apptics 🙌\n\n` +
      `Your call is on ${formattedDate} at ${formattedTime}. See you there!\n\n` +
      `If you need to reschedule, just reply "reschedule" 🗓️`;

    const result = await this.sendMessage(phoneNumber, fromNumber, message, apiKey, apiSecret);

    // Log to timeline
    await this.logToTimeline(leadId, workspaceId, 'iMessage sent', message);

    return result;
  }

  async handleInboundMessage(
    fromNumber: string,
    content: string,
    workspaceId: string,
  ): Promise<void> {
    const apiKey = process.env.SENDBLUE_API_KEY;
    const apiSecret = process.env.SENDBLUE_API_SECRET;
    const sendblueNumber = process.env.SENDBLUE_FROM_NUMBER;

    if (!apiKey || !apiSecret || !sendblueNumber) {
      return;
    }

    // Log inbound message to timeline
    const schema = getWorkspaceSchemaName(workspaceId);
    const lead = await this.findLeadByPhone(schema, fromNumber);

    if (lead) {
      await this.logToTimeline(lead.id, workspaceId, 'iMessage received', content);
    }

    // Check if message is a reschedule request
    const normalized = content.trim().toLowerCase();

    if (normalized === 'reschedule' || normalized === 'reschedule') {
      const reply = `No worries! Here's your reschedule link:\n${RESCHEDULE_URL}`;

      await this.sendMessage(fromNumber, sendblueNumber, reply, apiKey, apiSecret);

      if (lead) {
        await this.logToTimeline(lead.id, workspaceId, 'iMessage sent', reply);
      }

      this.logger.log(`Sent reschedule link to ${fromNumber}`);
    }
  }

  private async sendMessage(
    to: string,
    from: string,
    content: string,
    apiKey: string,
    apiSecret: string,
  ): Promise<SendblueResponse> {
    try {
      const response = await fetch(SENDBLUE_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'sb-api-key-id': apiKey,
          'sb-api-secret-key': apiSecret,
        },
        body: JSON.stringify({
          number: to,
          from_number: from,
          content,
          status_callback: '',
        }),
        signal: AbortSignal.timeout(10_000),
      });

      const result = await response.json() as SendblueResponse;

      if (result.error_message) {
        this.logger.warn(`Sendblue error for ${to}: ${result.error_message}`);
      } else {
        this.logger.log(`iMessage sent to ${to}: ${result.message_handle}`);
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to send iMessage to ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return { error_message: error instanceof Error ? error.message : String(error) };
    }
  }

  private async logToTimeline(
    leadId: string,
    workspaceId: string,
    eventName: string,
    messageContent: string,
  ): Promise<void> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const leadMetaId = await this.getLeadObjectMetadataId(workspaceId);

    if (!leadMetaId) return;

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
          JSON.stringify({ message: messageContent, channel: 'iMessage' }),
          leadId,
          leadMetaId,
        ],
      );
    } catch (error) {
      this.logger.warn(
        `Failed to log timeline for lead ${leadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async findLeadByPhone(
    schema: string,
    phone: string,
  ): Promise<{ id: string; name: string } | null> {
    // Normalize phone — strip spaces, dashes
    const normalized = phone.replace(/[\s\-()]/g, '');

    const results = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE "phonesPrimaryPhoneNumber" = $1
       OR "phonesPrimaryPhoneNumber" = $2
       LIMIT 1`,
      [phone, normalized],
    );

    return results[0] ?? null;
  }

  private async getLeadObjectMetadataId(workspaceId: string): Promise<string | null> {
    const result = await this.dataSource.query(
      `SELECT id FROM core."objectMetadata" WHERE "nameSingular" = 'lead' AND "workspaceId" = $1 LIMIT 1`,
      [workspaceId],
    );

    return result[0]?.id ?? null;
  }
}
