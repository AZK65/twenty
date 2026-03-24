import { Injectable, Logger } from '@nestjs/common';

import { v4 as uuidv4 } from 'uuid';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

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

// Maps Close CRM opportunity status to Twenty stage
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
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async importLeads(
    leads: CloseLead[],
    workspaceId: string,
  ): Promise<ImportResult> {
    const authContext = buildSystemAuthContext(workspaceId);
    const result: ImportResult = {
      total: leads.length,
      imported: 0,
      skipped: 0,
      errors: [],
    };

    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const leadRepository =
          await this.globalWorkspaceOrmManager.getRepository<LeadWorkspaceEntity>(
            workspaceId,
            'lead',
            { shouldBypassPermissionChecks: true },
          );

        for (let i = 0; i < leads.length; i++) {
          const closeLead = leads[i];

          try {
            const mapped = this.mapCloseLead(closeLead);

            await leadRepository.insert({
              id: uuidv4(),
              ...mapped,
            } as Partial<LeadWorkspaceEntity>);

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
      },
      authContext,
    );

    this.logger.log(
      `Close CRM import complete: ${result.imported}/${result.total} imported, ${result.errors.length} errors`,
    );

    return result;
  }

  private mapCloseLead(lead: CloseLead): Partial<LeadWorkspaceEntity> {
    const contact = lead.contacts?.[0];
    const primaryOpp = lead.opportunities?.[0];

    // Name: prefer contact name, fall back to display_name
    const name = contact?.display_name
      || contact?.name
      || lead.display_name
      || lead.name
      || 'Unknown';

    // Email
    const primaryEmail = contact?.emails?.[0]?.email ?? '';
    const additionalEmails = (contact?.emails ?? [])
      .slice(1)
      .map((e) => e.email);

    // Phone
    const primaryPhone = contact?.phones?.[0]?.phone ?? '';

    // Stage: derive from status_label, fall back to opportunity status
    const stage = CLOSE_STATUS_TO_STAGE[lead.status_label]
      ?? (primaryOpp ? CLOSE_OPP_STATUS_TO_STAGE[primaryOpp.status_label] : undefined)
      ?? 'NEW';

    // Source from custom fields
    const source = lead.custom?.['Lead Source'] ?? 'CLOSE_CRM_IMPORT';
    const sourceDetail = this.buildSourceDetail(lead.custom);

    // MRR from opportunity value
    const estimatedValue = primaryOpp && primaryOpp.value > 0
      ? {
          amountMicros: primaryOpp.value * 1_000_000,
          currencyCode: primaryOpp.value_currency || 'USD',
        }
      : null;

    // Needs: combine opportunity notes, description, and custom fields
    const needs = this.buildNeeds(lead, primaryOpp);

    // Priority based on Close status
    const priority = lead.status_label === 'Customer'
      ? 'HIGH'
      : lead.status_label === 'Discovery Call Booked' || lead.status_label === 'Follow-up Scheduled'
        ? 'HIGH'
        : 'MEDIUM';

    return {
      name,
      emails: {
        primaryEmail,
        additionalEmails,
      },
      phones: {
        primaryPhoneNumber: primaryPhone,
        primaryPhoneCountryCode: contact?.phones?.[0]?.country ?? '',
        additionalPhones: [],
      },
      source,
      sourceDetail,
      needs,
      stage,
      priority,
      enrichmentStatus: 'NOT_ENRICHED',
      estimatedValue,
    } as Partial<LeadWorkspaceEntity>;
  }

  private buildSourceDetail(custom: Record<string, string>): string | null {
    const parts: Record<string, string> = {};

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
