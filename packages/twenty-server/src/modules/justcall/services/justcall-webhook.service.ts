import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import { DeepgramTranscriptionService } from 'src/modules/justcall/services/deepgram-transcription.service';

// Handles inbound JustCall `call_completed` webhooks.
// Matches the call to a Lead by phone number, optionally transcribes the
// recording via Deepgram, and writes a timeline entry (name =
// "lead.phone_call_completed") on the lead.

type JustcallWebhookPayload = {
  event?: string;
  data?: JustcallCall;
  call?: JustcallCall;
  [key: string]: unknown;
};

type JustcallCall = {
  id?: string | number;
  call_sid?: string;
  call_date?: string;
  call_time?: string;
  call_user_date?: string;
  direction?: string;
  type?: string;
  call_duration?: number | string;
  call_duration_in_seconds?: number | string;
  ring_duration?: number | string;
  queue_wait_duration?: number | string;
  call_traits?: string[];
  agent_name?: string;
  agent_email?: string;
  agent_id?: string | number;
  justcall_number?: string;
  contact_number?: string;
  contact_name?: string;
  contact_email?: string;
  disposition?: string;
  notes?: string;
  rating?: number;
  recording?: string;
  recording_url?: string;
  recording_duration?: number | string;
  campaign_id?: string | number;
  campaign_name?: string;
  ai_insights?: {
    transcription?: string;
    summary?: string;
    sentiment?: string;
    call_score?: number;
    action_items?: string[];
    moments?: unknown;
    questions_asked?: unknown;
  };
  [key: string]: unknown;
};

@Injectable()
export class JustcallWebhookService {
  private readonly logger = new Logger(JustcallWebhookService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly transcriptionService: DeepgramTranscriptionService,
  ) {}

  async handleCallCompleted(
    payload: JustcallWebhookPayload,
    workspaceId: string,
  ): Promise<{ handled: boolean; leadId?: string; reason?: string }> {
    const call = payload.data ?? payload.call ?? (payload as unknown as JustcallCall);

    if (!call || typeof call !== 'object') {
      return { handled: false, reason: 'Missing call object in payload' };
    }

    const direction = (call.direction ?? '').toLowerCase();

    // Outbound-only per product requirement.
    if (direction && direction !== 'outgoing' && direction !== 'outbound') {
      return { handled: false, reason: `Skipping ${direction} call` };
    }

    const contactNumber = call.contact_number;

    if (!contactNumber) {
      return { handled: false, reason: 'Missing contact_number' };
    }

    const schema = getWorkspaceSchemaName(workspaceId);
    const lead = await this.findLeadByPhone(schema, contactNumber);

    if (!lead) {
      this.logger.log(`No lead match for incoming JustCall number ${contactNumber}`);

      return { handled: false, reason: 'No matching lead' };
    }

    const leadMetaId = await this.getLeadObjectMetadataId(workspaceId);

    if (!leadMetaId) {
      return { handled: false, reason: 'Lead object metadata not found' };
    }

    // Build the timeline properties payload
    const recordingUrl = call.recording ?? call.recording_url;
    const ai = call.ai_insights ?? {};
    let transcriptAgent: string | undefined = undefined;
    let transcriptLead: string | undefined = undefined;
    let transcriptFull: string | undefined = ai.transcription;

    // Only transcribe if JustCall AI didn't already supply a transcript
    if (!transcriptFull && recordingUrl) {
      const result = await this.transcriptionService.transcribeFromUrl(recordingUrl);

      if (result) {
        transcriptFull = result.full;
        transcriptAgent = result.agent;
        transcriptLead = result.lead;
      }
    }

    const happensAt = this.parseDate(call.call_date) ?? new Date();

    const properties = {
      justcallCallId: call.id ?? call.call_sid,
      direction: 'Outgoing',
      outcome: call.type,
      disposition: call.disposition,
      durationSeconds: this.toNumber(call.call_duration_in_seconds ?? call.call_duration),
      ringSeconds: this.toNumber(call.ring_duration),
      agentName: call.agent_name,
      agentEmail: call.agent_email,
      justcallNumber: call.justcall_number,
      contactNumber: call.contact_number,
      campaignId: call.campaign_id,
      campaignName: call.campaign_name,
      recordingUrl,
      agentNotes: call.notes,
      rating: call.rating,
      transcript: transcriptFull,
      transcriptAgent,
      transcriptLead,
      summary: ai.summary,
      sentiment: ai.sentiment,
      callScore: ai.call_score,
      actionItems: ai.action_items,
    };

    await this.dataSource.query(
      `INSERT INTO "${schema}"."timelineActivity" (
        "id", "happensAt", "name", "properties",
        "linkedRecordCachedName", "linkedRecordId", "linkedObjectMetadataId",
        "targetLeadId",
        "createdAt", "updatedAt", "position"
      ) VALUES (
        $1, $2, 'lead.phone_call_completed', $3,
        '', $4, $5,
        $4,
        NOW(), NOW(), 0
      )`,
      [
        uuidv4(),
        happensAt.toISOString(),
        JSON.stringify(properties),
        lead.id,
        leadMetaId,
      ],
    );

    this.logger.log(
      `JustCall call logged for lead ${lead.id} (call ${properties.justcallCallId})`,
    );

    return { handled: true, leadId: lead.id };
  }

  private async findLeadByPhone(
    schema: string,
    phone: string,
  ): Promise<{ id: string; name: string } | null> {
    const digitsOnly = phone.replace(/\D/g, '');
    const last10 = digitsOnly.slice(-10);

    const results = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE "phonesPrimaryPhoneNumber" = $1
          OR "phonesPrimaryPhoneNumber" = $2
          OR regexp_replace("phonesPrimaryPhoneNumber", '\\D', '', 'g') LIKE '%' || $3
       LIMIT 1`,
      [phone, digitsOnly, last10],
    );

    return results[0] ?? null;
  }

  private async getLeadObjectMetadataId(
    workspaceId: string,
  ): Promise<string | null> {
    const result = await this.dataSource.query(
      `SELECT id FROM core."objectMetadata"
       WHERE "nameSingular" = 'lead' AND "workspaceId" = $1 LIMIT 1`,
      [workspaceId],
    );

    return result[0]?.id ?? null;
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;

    const parsed = new Date(value);

    return isNaN(parsed.getTime()) ? null : parsed;
  }

  private toNumber(value: unknown): number | undefined {
    if (value === null || value === undefined || value === '') return undefined;
    const n = Number(value);

    return isNaN(n) ? undefined : n;
  }
}
