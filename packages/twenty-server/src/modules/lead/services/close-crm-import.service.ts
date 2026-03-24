import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';

// Maps Close CRM status labels to Twenty lead stages
const CLOSE_STATUS_TO_STAGE: Record<string, string> = {
  'Potential': 'NEW',
  'Qualified': 'QUALIFIED',
  'Discovery Call Booked': 'MEETING_SCHEDULED',
  'Follow-up Scheduled': 'PRE_CALL',
  'Rescheduled': 'PRE_CALL',
  'No Show': 'CONTACTED',
  'Customer': 'WON',
  'DNC': 'LOST',
  'Disqualified': 'LOST',
  'Not Qualified / Money': 'LOST',
  'Bad Number': 'LOST',
  'Bad Fit / Not Interested': 'LOST',
  'Contact Cancelled': 'LOST',
  'Admin Cancelled': 'LOST',
};

const CLOSE_OPP_STATUS_TO_STAGE: Record<string, string> = {
  'Demo Booked': 'MEETING_SCHEDULED',
  'Demo Completed': 'QUALIFIED',
  'Demo Not Completed': 'CONTACTED',
  'Potential': 'NEW',
  'Won': 'WON',
  'Lost': 'LOST',
  '7 Day Ghost👻': 'CONTACTED',
  '30 Day Ghost👻': 'CONTACTED',
};

type CloseLead = {
  id: string;
  name: string;
  display_name: string;
  description: string;
  status_label: string;
  date_created: string;
  contacts: Array<{
    name: string;
    display_name: string;
    emails: Array<{ email: string; type: string }>;
    phones: Array<{ phone: string; phone_formatted: string; country: string | null }>;
    title: string | null;
  }>;
  opportunities: Array<{
    value: number;
    value_currency: string;
    value_period: string;
    status_label: string;
    status_type: string;
    confidence: number;
    note: string;
    date_won: string | null;
    date_lost: string | null;
  }>;
  custom: Record<string, string>;
};

export type ImportResult = {
  total: number;
  imported: number;
  skipped: number;
  errors: Array<{ index: number; name: string; error: string }>;
};

@Injectable()
export class CloseCrmImportService {
  private readonly logger = new Logger(CloseCrmImportService.name);

  constructor(
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  async importLeads(
    leads: CloseLead[],
    workspaceId: string,
  ): Promise<ImportResult> {
    const result: ImportResult = {
      total: leads.length,
      imported: 0,
      skipped: 0,
      errors: [],
    };

    const schemaName = getWorkspaceSchemaName(workspaceId);

    for (let i = 0; i < leads.length; i++) {
      const closeLead = leads[i];

      try {
        const mapped = this.mapCloseLead(closeLead);

        await this.coreDataSource.query(
          `INSERT INTO "${schemaName}"."lead" (
            "id", "name",
            "emailsPrimaryEmail", "emailsAdditionalEmails",
            "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
            "source", "sourceDetail", "needs",
            "stage", "priority", "enrichmentStatus",
            "estimatedValueAmountMicros", "estimatedValueCurrencyCode",
            "position",
            "createdAt", "updatedAt"
          ) VALUES (
            $1, $2,
            $3, $4,
            $5, $6, '', $7,
            $8, $9, $10,
            $11, $12, $13,
            $14, $15,
            0,
            NOW(), NOW()
          )`,
          [
            uuidv4(),
            mapped.name,
            mapped.primaryEmail,
            JSON.stringify(mapped.additionalEmails),
            mapped.primaryPhone,
            mapped.phoneCountryCode,
            JSON.stringify([]),
            mapped.source,
            mapped.sourceDetail,
            mapped.needs,
            mapped.stage,
            mapped.priority,
            mapped.enrichmentStatus,
            mapped.estimatedValueAmountMicros,
            mapped.estimatedValueCurrencyCode,
          ],
        );

        result.imported++;
      } catch (error) {
        const displayName = closeLead.display_name || closeLead.name || `index ${i}`;

        this.logger.warn(
          `Failed to import lead "${displayName}": ${error instanceof Error ? error.message : String(error)}`,
        );

        result.errors.push({
          index: i,
          name: displayName,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    this.logger.log(
      `Close CRM import complete: ${result.imported}/${result.total} imported, ${result.errors.length} errors`,
    );

    return result;
  }

  private mapCloseLead(lead: CloseLead) {
    const contact = lead.contacts?.[0];
    const primaryOpp = lead.opportunities?.[0];

    const name = contact?.display_name
      || contact?.name
      || lead.display_name
      || lead.name
      || 'Unknown';

    const primaryEmail = contact?.emails?.[0]?.email ?? '';
    const additionalEmails = (contact?.emails ?? []).slice(1).map((e) => e.email);
    const primaryPhone = contact?.phones?.[0]?.phone ?? '';
    const phoneCountryCode = contact?.phones?.[0]?.country ?? '';

    const stage = CLOSE_STATUS_TO_STAGE[lead.status_label]
      ?? (primaryOpp ? CLOSE_OPP_STATUS_TO_STAGE[primaryOpp.status_label] : undefined)
      ?? 'NEW';

    const source = this.mapSource(lead.custom?.['Lead Source']);
    const sourceDetail = this.buildSourceDetail(lead.custom);
    const needs = this.buildNeeds(lead, primaryOpp);

    const priority = lead.status_label === 'Customer'
      || lead.status_label === 'Discovery Call Booked'
      || lead.status_label === 'Follow-up Scheduled'
        ? 'HIGH'
        : 'MEDIUM';

    const estimatedValueAmountMicros = primaryOpp && primaryOpp.value > 0
      ? primaryOpp.value * 1_000_000
      : null;
    const estimatedValueCurrencyCode = primaryOpp?.value_currency || null;

    return {
      name,
      primaryEmail,
      additionalEmails,
      primaryPhone,
      phoneCountryCode,
      source,
      sourceDetail,
      needs,
      stage,
      priority,
      enrichmentStatus: 'NOT_ENRICHED',
      estimatedValueAmountMicros,
      estimatedValueCurrencyCode,
    };
  }

  // Valid enum: WEBSITE, REFERRAL, COLD_OUTREACH, SOCIAL_MEDIA, PAID_AD, EVENT, PARTNER, OTHER
  private mapSource(leadSource: string | undefined): string {
    if (!leadSource) return 'OTHER';

    const lower = leadSource.toLowerCase();

    if (lower.includes('referral') || lower.includes('affiliate')) return 'REFERRAL';
    if (lower.includes('social') || lower.includes('x bio') || lower.includes('instagram') || lower.includes('twitter')) return 'SOCIAL_MEDIA';
    if (lower.includes('website') || lower.includes('lp form') || lower.includes('landing')) return 'WEBSITE';
    if (lower.includes('ad') || lower.includes('paid') || lower.includes('ppc')) return 'PAID_AD';
    if (lower.includes('cold') || lower.includes('outreach') || lower.includes('outbound')) return 'COLD_OUTREACH';
    if (lower.includes('event') || lower.includes('conference') || lower.includes('meetup')) return 'EVENT';
    if (lower.includes('partner')) return 'PARTNER';

    return 'OTHER';
  }

  private buildSourceDetail(custom: Record<string, string>): string | null {
    const parts: Record<string, string> = {};

    if (custom?.['Lead Source']) parts.originalSource = custom['Lead Source'];
    if (custom?.['Source Platform']) parts.platform = custom['Source Platform'];
    if (custom?.['Source Funnel']) parts.funnel = custom['Source Funnel'];
    if (custom?.['Source Content']) parts.content = custom['Source Content'];
    if (custom?.['Affiliate Email']) parts.affiliateEmail = custom['Affiliate Email'];

    return Object.keys(parts).length > 0 ? JSON.stringify(parts) : null;
  }

  private buildNeeds(
    lead: CloseLead,
    opp: CloseLead['opportunities'][0] | undefined,
  ): string {
    const parts: string[] = [];

    if (lead.custom?.['Demo Type']) {
      parts.push(`Demo Type: ${lead.custom['Demo Type']}`);
    }

    if (lead.custom?.['Monthly Revenue (iClose Form)']) {
      parts.push(`Monthly Revenue: ${lead.custom['Monthly Revenue (iClose Form)']}`);
    }

    if (lead.custom?.['Experienced Shopify Bans?']) {
      parts.push(`Shopify Bans: ${lead.custom['Experienced Shopify Bans?']}`);
    }

    if (lead.custom?.['Telegram Username']) {
      parts.push(`Telegram: ${lead.custom['Telegram Username']}`);
    }

    if (opp?.note) {
      parts.push(opp.note);
    }

    if (lead.description) {
      parts.push(lead.description);
    }

    return parts.join('\n') || '';
  }
}
