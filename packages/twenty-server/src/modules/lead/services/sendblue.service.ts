import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// Bloo.io iMessage integration (blooio.com)
// Sends an auto-welcome iMessage when a lead books a call,
// and handles inbound "reschedule" replies.
//
// Environment variables:
//   BLOO_API_KEY — Bloo API key (Bearer token)

const BLOO_API_URL = 'https://backend.blooio.com/v2/api';

type BlooResponse = {
  message_id?: string;
  status?: string;
  error?: string;
  message?: string;
};

@Injectable()
export class SendblueService {
  private readonly logger = new Logger('BlooService');

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async sendCallBookedMessage(
    leadId: string,
    leadName: string,
    phoneNumber: string,
    callTime: string,
    bookingUid: string,
    workspaceId: string,
  ): Promise<BlooResponse | null> {
    const apiKey = process.env.BLOO_API_KEY;

    if (!apiKey) {
      this.logger.debug('BLOO_API_KEY not configured — skipping iMessage');

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

    const result = await this.sendMessage(phoneNumber, message, apiKey);

    // Store booking UID on the lead for reschedule link
    if (bookingUid) {
      const schema = getWorkspaceSchemaName(workspaceId);

      await this.dataSource.query(
        `UPDATE "${schema}"."lead" SET "linkedinLinkPrimaryLinkLabel" = 'Reschedule Link',
         "linkedinLinkPrimaryLinkUrl" = $1 WHERE id = $2`,
        [`https://cal.com/reschedule/${bookingUid}`, leadId],
      );
    }

    // Log to timeline
    await this.logToTimeline(leadId, workspaceId, 'iMessage sent', message);

    return result;
  }

  async handleInboundMessage(
    fromNumber: string,
    content: string,
    workspaceId: string,
  ): Promise<void> {
    const apiKey = process.env.BLOO_API_KEY;

    if (!apiKey) {
      return;
    }

    const schema = getWorkspaceSchemaName(workspaceId);

    // Log inbound message to timeline
    const lead = await this.findLeadByPhone(schema, fromNumber);

    if (lead) {
      await this.logToTimeline(lead.id, workspaceId, 'iMessage received', content);
    }

    // Check if message is a reschedule request
    const normalized = content.trim().toLowerCase();

    if (normalized === 'reschedule') {
      let rescheduleUrl = 'https://cal.com/team/apptics/intro';

      if (lead) {
        const linkResult = await this.dataSource.query(
          `SELECT "linkedinLinkPrimaryLinkUrl" FROM "${schema}"."lead" WHERE id = $1`,
          [lead.id],
        );

        if (linkResult[0]?.linkedinLinkPrimaryLinkUrl) {
          rescheduleUrl = linkResult[0].linkedinLinkPrimaryLinkUrl;
        }
      }

      const reply = `No worries! Here's your reschedule link:\n${rescheduleUrl}`;

      await this.sendMessage(fromNumber, reply, apiKey);

      if (lead) {
        await this.logToTimeline(lead.id, workspaceId, 'iMessage sent', reply);
      }

      this.logger.log(`Sent reschedule link to ${fromNumber}`);
    }
  }

  private async sendMessage(
    to: string,
    content: string,
    apiKey: string,
  ): Promise<BlooResponse> {
    // URL-encode the phone number for the chat ID
    const chatId = encodeURIComponent(to);

    try {
      const response = await fetch(`${BLOO_API_URL}/chats/${chatId}/messages`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ text: content }),
        signal: AbortSignal.timeout(10_000),
      });

      const result = await response.json() as BlooResponse;

      if (result.error) {
        this.logger.warn(`Bloo error for ${to}: ${result.message}`);
      } else {
        this.logger.log(`iMessage sent to ${to}: ${result.message_id}`);
      }

      return result;
    } catch (error) {
      this.logger.error(
        `Failed to send iMessage to ${to}: ${error instanceof Error ? error.message : String(error)}`,
      );

      return { error: error instanceof Error ? error.message : String(error) };
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
