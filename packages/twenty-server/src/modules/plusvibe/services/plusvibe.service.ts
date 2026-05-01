import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// PlusVibe.ai (cold email) integration.
// Pushes CRM leads into a PlusVibe campaign and writes a timeline entry
// (name = "lead.pushed_to_plusvibe") that also serves as the dedupe marker.
//
// Env vars:
//   PLUSVIBE_API_KEY        — x-api-key header
//   PLUSVIBE_WORKSPACE_ID   — required on every request

const PLUSVIBE_API_BASE = 'https://api.plusvibe.ai/api/v1';

// PlusVibe accepts: a@b.tld, no plus aliases, no uppercase domains.
const PLUSVIBE_EMAIL_RE =
  /^[a-z0-9]([a-z0-9._-]*[a-z0-9])?@[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{1,}$/i;

type PlusvibeCampaign = {
  id: string;
  name: string;
  status?: string;
};

export type PlusvibeLeadFilters = {
  companyRevenues?: string[];
  minAgeDays?: number;
  maxAgeDays?: number;
  // 'all' (default) | 'us' (phone is NANP +1) | 'non_us' (phone exists but
  // is not NANP). Leads without a phone are included in 'all' and 'non_us'.
  countryFilter?: 'all' | 'us' | 'non_us';
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
  companyRevenue: string | null;
  createdAt: string;
};

const MATCH_ALL_MAX = 1000;

@Injectable()
export class PlusvibeService {
  private readonly logger = new Logger(PlusvibeService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  private getConfig(): { headers: Record<string, string>; workspaceId: string } | null {
    const apiKey = process.env.PLUSVIBE_API_KEY;
    const wsId = process.env.PLUSVIBE_WORKSPACE_ID;

    if (!apiKey || !wsId) {
      this.logger.warn('PLUSVIBE_API_KEY/WORKSPACE_ID not set');
      return null;
    }

    return {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      workspaceId: wsId,
    };
  }

  async listCampaigns(): Promise<PlusvibeCampaign[]> {
    const cfg = this.getConfig();

    if (!cfg) return [];

    try {
      const response = await fetch(
        `${PLUSVIBE_API_BASE}/campaign/list?workspace_id=${cfg.workspaceId}`,
        { method: 'GET', headers: cfg.headers, signal: AbortSignal.timeout(15_000) },
      );

      if (!response.ok) {
        this.logger.warn(`PlusVibe listCampaigns failed: ${response.status}`);
        return [];
      }

      const data = (await response.json()) as Array<{
        id?: string;
        _id?: string;
        name?: string;
        status?: string;
      }>;

      return data
        .filter((c) => c.name)
        .map((c) => ({
          id: (c.id ?? c._id ?? '') as string,
          name: c.name as string,
          status: c.status,
        }));
    } catch (error) {
      this.logger.error(
        `PlusVibe listCampaigns error: ${error instanceof Error ? error.message : String(error)}`,
      );
      return [];
    }
  }

  private buildFilterSql(
    schema: string,
    filters: PlusvibeLeadFilters,
  ): { whereClause: string; params: unknown[] } {
    const clauses: string[] = [
      '"emailsPrimaryEmail" IS NOT NULL',
      '"emailsPrimaryEmail" != \'\'',
    ];
    const params: unknown[] = [];

    if (
      filters.companyRevenues &&
      filters.companyRevenues.length > 0 &&
      filters.companyRevenues.every((r) => typeof r === 'string')
    ) {
      params.push(filters.companyRevenues);
      clauses.push(`"companyRevenue" = ANY($${params.length}::text[])`);
    }

    if (filters.maxAgeDays && filters.maxAgeDays > 0) {
      params.push(filters.maxAgeDays);
      clauses.push(
        `"createdAt" >= NOW() - ($${params.length}::int * INTERVAL '1 day')`,
      );
    }

    if (filters.minAgeDays && filters.minAgeDays > 0) {
      params.push(filters.minAgeDays);
      clauses.push(
        `"createdAt" <= NOW() - ($${params.length}::int * INTERVAL '1 day')`,
      );
    }

    if (filters.countryFilter === 'us') {
      // Phone normalizes to NANP +1 (1[2-9]\d{9})
      clauses.push(
        `"phonesPrimaryPhoneNumber" IS NOT NULL AND "phonesPrimaryPhoneNumber" != ''
         AND regexp_replace("phonesPrimaryPhoneNumber", '[^0-9]', '', 'g') ~ '^1[2-9][0-9]{9}$'`,
      );
    } else if (filters.countryFilter === 'non_us') {
      // Has a phone, but doesn't normalize to NANP. Leads with no phone
      // pass through too (international leads sometimes lack phones).
      clauses.push(
        `(
          "phonesPrimaryPhoneNumber" IS NULL
          OR "phonesPrimaryPhoneNumber" = ''
          OR regexp_replace("phonesPrimaryPhoneNumber", '[^0-9]', '', 'g') !~ '^1[2-9][0-9]{9}$'
        )`,
      );
    }

    return { whereClause: clauses.join(' AND '), params };
  }

  async queryMatchingLeadIds(
    workspaceId: string,
    filters: PlusvibeLeadFilters,
  ): Promise<string[]> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const { whereClause, params } = this.buildFilterSql(schema, filters);

    params.push(MATCH_ALL_MAX);

    const rows = await this.dataSource.query(
      `SELECT id FROM "${schema}"."lead"
       WHERE ${whereClause}
       ORDER BY "createdAt" DESC
       LIMIT $${params.length}`,
      params,
    );

    return rows.map((r: { id: string }) => r.id);
  }

  async previewMatching(
    workspaceId: string,
    filters: PlusvibeLeadFilters,
    sampleSize: number,
  ): Promise<{
    count: number;
    sample: Array<{
      id: string;
      name: string;
      email: string;
      companyRevenue: string | null;
      createdAt: string;
    }>;
  }> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const { whereClause, params } = this.buildFilterSql(schema, filters);

    const countRow = await this.dataSource.query(
      `SELECT COUNT(*)::int AS c FROM "${schema}"."lead" WHERE ${whereClause}`,
      params,
    );
    const count = Math.min(countRow[0]?.c ?? 0, MATCH_ALL_MAX);

    params.push(sampleSize);
    const sample = await this.dataSource.query(
      `SELECT id, name,
              "emailsPrimaryEmail" AS email,
              "companyRevenue" AS "companyRevenue",
              "createdAt"::text AS "createdAt"
       FROM "${schema}"."lead"
       WHERE ${whereClause}
       ORDER BY "createdAt" DESC
       LIMIT $${params.length}`,
      params,
    );

    return { count, sample };
  }

  async pushLeadsToCampaign(
    leadIds: string[],
    campaignId: string,
    workspaceId: string,
    filters: PlusvibeLeadFilters = {},
  ): Promise<PushResult> {
    const cfg = this.getConfig();
    const result: PushResult = {
      sent: 0,
      skipped: 0,
      filtered: 0,
      failed: 0,
      failures: [],
    };

    if (!cfg) {
      result.failed = leadIds.length;
      result.failures = leadIds.map((id) => ({
        leadId: id,
        reason: 'PlusVibe credentials not configured',
      }));
      return result;
    }

    const schema = getWorkspaceSchemaName(workspaceId);
    const leadMetaId = await this.getLeadObjectMetadataId(workspaceId);

    if (!leadMetaId) {
      result.failed = leadIds.length;
      return result;
    }

    const leads = await this.fetchLeads(schema, leadIds);
    const foundIds = new Set(leads.map((l) => l.id));

    for (const missingId of leadIds.filter((id) => !foundIds.has(id))) {
      result.failed++;
      result.failures.push({ leadId: missingId, reason: 'Lead not found' });
    }

    const alreadySent = await this.findAlreadyPushedLeadIds(
      schema,
      leads.map((l) => l.id),
    );

    const revenueFilter =
      filters.companyRevenues && filters.companyRevenues.length > 0
        ? new Set(filters.companyRevenues)
        : null;

    type Pending = { lead: LeadRow; email: string };
    const pending: Pending[] = [];

    for (const lead of leads) {
      if (alreadySent.has(lead.id)) {
        result.skipped++;
        continue;
      }

      if (revenueFilter && !revenueFilter.has(lead.companyRevenue ?? '')) {
        result.filtered++;
        continue;
      }

      const email = (lead.emailsPrimaryEmail ?? '').trim();

      if (!email || !PLUSVIBE_EMAIL_RE.test(email)) {
        result.filtered++;
        continue;
      }

      pending.push({ lead, email });
    }

    if (pending.length === 0) {
      this.logger.log(
        `PlusVibe push (ws=${workspaceId}, campaign=${campaignId}): nothing to send`,
      );
      return result;
    }

    // PlusVibe accepts a batch — push in chunks of 100.
    const CHUNK = 100;

    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      const apiLeads = chunk.map(({ lead, email }) => {
        const [first, ...rest] = (lead.name ?? '').trim().split(/\s+/);

        return {
          email,
          first_name: first || lead.name || '',
          last_name: rest.join(' ') || undefined,
        };
      });

      try {
        const response = await fetch(`${PLUSVIBE_API_BASE}/lead/add`, {
          method: 'POST',
          headers: { ...cfg.headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            workspace_id: cfg.workspaceId,
            campaign_id: campaignId,
            leads: apiLeads,
          }),
          signal: AbortSignal.timeout(20_000),
        });

        const json = (await response.json()) as {
          status?: string;
          leads_uploaded?: number;
          duplicate_email_count?: number;
          invalid_email_count?: number;
          already_in_campaign?: number;
          message?: string;
          error?: string;
        };

        if (!response.ok || json.status !== 'success') {
          throw new Error(
            `PlusVibe ${response.status}: ${json.error ?? json.message ?? 'unknown'}`,
          );
        }

        for (const { lead } of chunk) {
          await this.recordPush(schema, leadMetaId, lead.id, campaignId);
        }

        result.sent += json.leads_uploaded ?? chunk.length;

        const dups = json.duplicate_email_count ?? 0;
        const inCamp = json.already_in_campaign ?? 0;

        if (dups + inCamp > 0) result.skipped += dups + inCamp;

        if ((json.invalid_email_count ?? 0) > 0) {
          result.filtered += json.invalid_email_count ?? 0;
        }
      } catch (error) {
        for (const { lead } of chunk) {
          result.failed++;
          result.failures.push({
            leadId: lead.id,
            reason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    this.logger.log(
      `PlusVibe push (ws=${workspaceId}, campaign=${campaignId}): sent=${result.sent}, skipped=${result.skipped}, filtered=${result.filtered}, failed=${result.failed}`,
    );

    return result;
  }

  private async fetchLeads(schema: string, leadIds: string[]): Promise<LeadRow[]> {
    if (leadIds.length === 0) return [];

    return this.dataSource.query(
      `SELECT id, name,
              "emailsPrimaryEmail",
              "companyRevenue",
              "createdAt"::text AS "createdAt"
       FROM "${schema}"."lead"
       WHERE id = ANY($1::uuid[])`,
      [leadIds],
    );
  }

  private async findAlreadyPushedLeadIds(
    schema: string,
    leadIds: string[],
  ): Promise<Set<string>> {
    if (leadIds.length === 0) return new Set();

    const rows = await this.dataSource.query(
      `SELECT DISTINCT "targetLeadId" FROM "${schema}"."timelineActivity"
       WHERE "targetLeadId" = ANY($1::uuid[])
         AND name = 'lead.pushed_to_plusvibe'`,
      [leadIds],
    );

    return new Set(rows.map((r: { targetLeadId: string }) => r.targetLeadId));
  }

  private async recordPush(
    schema: string,
    leadMetaId: string,
    leadId: string,
    campaignId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO "${schema}"."timelineActivity" (
        "id", "happensAt", "name", "properties",
        "linkedRecordCachedName", "linkedRecordId", "linkedObjectMetadataId",
        "targetLeadId",
        "createdAt", "updatedAt", "position"
      ) VALUES (
        $1, NOW(), 'lead.pushed_to_plusvibe', $2,
        '', $3, $4,
        $3,
        NOW(), NOW(), 0
      )`,
      [uuidv4(), JSON.stringify({ campaignId }), leadId, leadMetaId],
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
