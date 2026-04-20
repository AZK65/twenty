import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// JustCall Sales Dialer integration.
// Pushes CRM leads into a JustCall dialer campaign and writes a timeline
// entry (name = "lead.pushed_to_justcall") that also serves as the dedupe marker.
//
// Environment variables:
//   JUSTCALL_API_KEY       — JustCall API key
//   JUSTCALL_API_SECRET    — JustCall API secret (v2.1 uses Basic key:secret auth)

const JUSTCALL_API_BASE = 'https://api.justcall.io/v1';

type JustcallCampaign = {
  id: number;
  name: string;
  status?: string;
  type?: string;
};

type PushResult = {
  sent: number;
  skipped: number;
  filtered: number;
  failed: number;
  failures: Array<{ leadId: string; reason: string }>;
};

type LeadRow = {
  id: string;
  name: string;
  emailsPrimaryEmail: string | null;
  phonesPrimaryPhoneNumber: string | null;
  phonesPrimaryPhoneCountryCode: string | null;
  phonesPrimaryPhoneCallingCode: string | null;
  companyRevenue: string | null;
};

export type LeadFilters = {
  // If set and non-empty, only push leads whose companyRevenue is in this list.
  companyRevenues?: string[];
  // If true, drop leads whose phone does not normalize to a US number (+1).
  usOnly?: boolean;
};

@Injectable()
export class JustcallService {
  private readonly logger = new Logger(JustcallService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private getAuthHeader(): string | null {
    const apiKey = process.env.JUSTCALL_API_KEY;
    const apiSecret = process.env.JUSTCALL_API_SECRET;

    if (!apiKey || !apiSecret) {
      this.logger.warn('JUSTCALL_API_KEY/SECRET not configured');

      return null;
    }

    // JustCall v2.1 auth format: raw "{key}:{secret}", no Basic prefix, no base64.
    return `${apiKey}:${apiSecret}`;
  }

  async listCampaigns(): Promise<JustcallCampaign[]> {
    const auth = this.getAuthHeader();

    if (!auth) return [];

    try {
      const response = await fetch(
        `${JUSTCALL_API_BASE}/autodialer/campaigns/list`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: '{}',
          signal: AbortSignal.timeout(15_000),
        },
      );

      if (!response.ok) {
        const text = await response.text();

        this.logger.warn(
          `JustCall listCampaigns failed: ${response.status} ${text}`,
        );

        return [];
      }

      const data = (await response.json()) as { data?: JustcallCampaign[] };

      return data.data ?? [];
    } catch (error) {
      this.logger.error(
        `JustCall listCampaigns error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return [];
    }
  }

  async listPhoneNumbers(): Promise<
    Array<{ id: number | string; name?: string; number?: string }>
  > {
    const auth = this.getAuthHeader();

    if (!auth) return [];

    try {
      const response = await fetch(`${JUSTCALL_API_BASE}/numbers/list`, {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: '{}',
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        const text = await response.text();

        this.logger.warn(
          `JustCall listPhoneNumbers failed: ${response.status} ${text}`,
        );

        return [];
      }

      const json = (await response.json()) as {
        data?: Array<{
          id?: number | string;
          phone?: string;
          phone_number?: string;
          friendly_name?: string;
          custom_name?: string;
          name?: string;
        }>;
      };

      return (json.data ?? []).map((p) => ({
        id: p.id ?? p.phone ?? p.phone_number ?? '',
        name: p.custom_name || p.friendly_name || p.name,
        number: p.phone ?? p.phone_number,
      }));
    } catch (error) {
      this.logger.error(
        `JustCall listPhoneNumbers error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return [];
    }
  }

  async createCampaign(
    name: string,
    phoneNumberId: number | string,
  ): Promise<JustcallCampaign | null> {
    const auth = this.getAuthHeader();

    if (!auth) return null;

    try {
      const response = await fetch(
        `${JUSTCALL_API_BASE}/autodialer/campaigns/create`,
        {
          method: 'POST',
          headers: {
            Authorization: auth,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            name,
            country_code: 'US',
            type: 'predictive',
            justcall_number: String(phoneNumberId).replace(/\D/g, ''),
          }),
          signal: AbortSignal.timeout(15_000),
        },
      );

      const json = (await response.json()) as {
        status?: string;
        campaign_id?: number | string;
        message?: string;
      };

      if (!response.ok || !json.campaign_id) {
        throw new Error(
          `JustCall createCampaign ${response.status}: ${json.message ?? 'unknown'}`,
        );
      }

      return { id: Number(json.campaign_id), name };
    } catch (error) {
      this.logger.error(
        `JustCall createCampaign error: ${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }
  }

  async pushLeadsToCampaign(
    leadIds: string[],
    campaignId: number,
    workspaceId: string,
    filters: LeadFilters = {},
  ): Promise<PushResult> {
    const auth = this.getAuthHeader();
    const result: PushResult = {
      sent: 0,
      skipped: 0,
      filtered: 0,
      failed: 0,
      failures: [],
    };

    if (!auth) {
      result.failed = leadIds.length;
      result.failures = leadIds.map((id) => ({
        leadId: id,
        reason: 'JustCall credentials not configured',
      }));

      return result;
    }

    const schema = getWorkspaceSchemaName(workspaceId);
    const leadMetaId = await this.getLeadObjectMetadataId(workspaceId);

    if (!leadMetaId) {
      result.failed = leadIds.length;
      result.failures = leadIds.map((id) => ({
        leadId: id,
        reason: 'Lead object metadata not found',
      }));

      return result;
    }

    // Fetch leads
    const leads = await this.fetchLeads(schema, leadIds);
    const foundIds = new Set(leads.map((l) => l.id));

    for (const missingId of leadIds.filter((id) => !foundIds.has(id))) {
      result.failed++;
      result.failures.push({ leadId: missingId, reason: 'Lead not found' });
    }

    // Dedupe: skip leads that already have a pushed_to_justcall timeline entry
    const alreadySent = await this.findAlreadyPushedLeadIds(schema, leads.map((l) => l.id));

    const revenueFilter =
      filters.companyRevenues && filters.companyRevenues.length > 0
        ? new Set(filters.companyRevenues)
        : null;

    for (const lead of leads) {
      if (alreadySent.has(lead.id)) {
        result.skipped++;
        continue;
      }

      if (revenueFilter && !revenueFilter.has(lead.companyRevenue ?? '')) {
        result.filtered++;
        continue;
      }

      const phone = this.buildE164Phone(lead);

      if (!phone) {
        result.failed++;
        result.failures.push({ leadId: lead.id, reason: 'Missing phone number' });
        continue;
      }

      if (filters.usOnly && !this.isUsPhone(phone)) {
        result.filtered++;
        continue;
      }

      try {
        const contactId = await this.pushContact(
          auth,
          campaignId,
          lead.name,
          phone,
          lead.emailsPrimaryEmail ?? undefined,
        );

        await this.recordPush(
          schema,
          leadMetaId,
          lead.id,
          campaignId,
          contactId,
          phone,
        );

        result.sent++;
      } catch (error) {
        result.failed++;
        result.failures.push({
          leadId: lead.id,
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `JustCall push (ws=${workspaceId}, campaign=${campaignId}): sent=${result.sent}, skipped=${result.skipped}, failed=${result.failed}`,
    );

    return result;
  }

  private async fetchLeads(schema: string, leadIds: string[]): Promise<LeadRow[]> {
    if (leadIds.length === 0) return [];

    return this.dataSource.query(
      `SELECT id, name,
              "emailsPrimaryEmail",
              "phonesPrimaryPhoneNumber",
              "phonesPrimaryPhoneCountryCode",
              "phonesPrimaryPhoneCallingCode",
              "companyRevenue"
       FROM "${schema}"."lead"
       WHERE id = ANY($1::uuid[])`,
      [leadIds],
    );
  }

  async listRevenueValues(workspaceId: string): Promise<string[]> {
    const schema = getWorkspaceSchemaName(workspaceId);

    const rows = await this.dataSource.query(
      `SELECT DISTINCT "companyRevenue" as value
       FROM "${schema}"."lead"
       WHERE "companyRevenue" IS NOT NULL AND "companyRevenue" != ''
       ORDER BY "companyRevenue"`,
    );

    return rows.map((r: { value: string }) => r.value);
  }

  // A phone is "US" if the E.164 form starts with +1 and the national
  // number is 10 digits. Rough but good enough for filtering CRM leads.
  private isUsPhone(e164: string): boolean {
    if (!e164.startsWith('+1')) return false;

    const digits = e164.slice(2).replace(/\D/g, '');

    return digits.length === 10;
  }

  private async findAlreadyPushedLeadIds(
    schema: string,
    leadIds: string[],
  ): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();

    const rows = await this.dataSource.query(
      `SELECT DISTINCT "targetLeadId" FROM "${schema}"."timelineActivity"
       WHERE "targetLeadId" = ANY($1::uuid[])
       AND name = 'lead.pushed_to_justcall'`,
      [leadIds],
    );

    return new Set(rows.map((r: { targetLeadId: string }) => r.targetLeadId));
  }

  // Build E.164 format. JustCall expects full international format e.g. +15551234567.
  private buildE164Phone(lead: LeadRow): string | null {
    const raw = lead.phonesPrimaryPhoneNumber?.trim();

    if (!raw) return null;

    if (raw.startsWith('+')) return raw.replace(/[\s\-()]/g, '');

    const callingCode = lead.phonesPrimaryPhoneCallingCode?.trim();
    const cleaned = raw.replace(/[\s\-()]/g, '');

    if (callingCode) {
      const code = callingCode.startsWith('+') ? callingCode : `+${callingCode}`;

      return `${code}${cleaned}`;
    }

    // Default to US if no calling code recorded (matches "US leads" scope)
    return `+1${cleaned}`;
  }

  private async pushContact(
    auth: string,
    campaignId: number,
    name: string,
    phone: string,
    email?: string,
  ): Promise<string | undefined> {
    const [firstName, ...rest] = name.trim().split(/\s+/);
    const lastName = rest.join(' ') || undefined;

    const body: Record<string, unknown> = {
      campaign_id: campaignId,
      first_name: firstName || name,
      phone,
    };

    if (lastName) body.last_name = lastName;
    if (email) body.email = email;

    const response = await fetch(
      `${JUSTCALL_API_BASE}/autodialer/campaigns/add`,
      {
        method: 'POST',
        headers: {
          Authorization: auth,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      },
    );

    const json = (await response.json()) as {
      status?: string;
      data?: Array<{ contact_id?: string | number }>;
      message?: string;
    };

    if (!response.ok || json.status !== 'success') {
      throw new Error(
        `JustCall API ${response.status}: ${json.message ?? 'unknown'}`,
      );
    }

    const contactId = json.data?.[0]?.contact_id;

    return contactId !== undefined ? String(contactId) : undefined;
  }

  private async recordPush(
    schema: string,
    leadMetaId: string,
    leadId: string,
    campaignId: number,
    justcallContactId: string | undefined,
    phone: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "${schema}"."timelineActivity" (
        "id", "happensAt", "name", "properties",
        "linkedRecordCachedName", "linkedRecordId", "linkedObjectMetadataId",
        "targetLeadId",
        "createdAt", "updatedAt", "position"
      ) VALUES (
        $1, NOW(), 'lead.pushed_to_justcall', $2,
        '', $3, $4,
        $3,
        NOW(), NOW(), 0
      )`,
      [
        uuidv4(),
        JSON.stringify({
          campaignId,
          justcallContactId,
          phone,
        }),
        leadId,
        leadMetaId,
      ],
    );
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
}
