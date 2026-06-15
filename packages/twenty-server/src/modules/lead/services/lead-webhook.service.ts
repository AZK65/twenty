import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  type AffiliateWebhookPayload,
  type LeadCreateData,
} from 'src/modules/lead/dtos/webhook.dto';

@Injectable()
export class LeadWebhookService {
  private readonly logger = new Logger(LeadWebhookService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  async createLeadFromAffiliate(
    data: AffiliateWebhookPayload,
    workspaceId: string,
  ): Promise<{ leadId: string }> {
    const metadata = {
      ...data.metadata,
      ...(data.affiliateId ? { affiliateId: data.affiliateId } : {}),
    };

    const leadData: LeadCreateData = {
      name: data.name,
      emails: {
        primaryEmail: data.email ?? '',
        additionalEmails: [],
      },
      phones: {
        primaryPhoneNumber: data.phone ?? '',
        primaryPhoneCountryCode: '',
        additionalPhones: [],
      },
      source: data.source ?? 'PARTNER',
      sourceDetail: data.affiliateId ?? data.sourceDetail ?? null,
      needs: this.buildNeedsField(data.needs, metadata),
      stage: 'NEW',
      priority: 'MEDIUM',
      enrichmentStatus: 'NOT_ENRICHED',
    };

    return this.persistLead(leadData, workspaceId);
  }

  async createLeadFromGenericWebhook(
    data: Record<string, unknown>,
    workspaceId: string,
  ): Promise<{ leadId: string }> {
    const leadData = this.mapGenericPayloadToLead(data);

    return this.persistLead(leadData, workspaceId);
  }

  mapGenericPayloadToLead(data: Record<string, unknown>): LeadCreateData {
    const name = this.extractString(data, [
      'name',
      'fullName',
      'full_name',
    ]) ?? this.buildNameFromParts(data) ?? 'Unknown';

    const email = this.extractString(data, [
      'email',
      'email_address',
      'emailAddress',
      'mail',
    ]) ?? '';

    const phone = this.extractString(data, [
      'phone',
      'phone_number',
      'phoneNumber',
      'telephone',
      'tel',
    ]) ?? '';

    const source = this.extractString(data, [
      'source',
      'utm_source',
      'utmSource',
      'referrer',
      'channel',
    ]) ?? 'OTHER';

    const notes = this.extractString(data, [
      'notes',
      'message',
      'description',
      'comment',
      'comments',
    ]);

    const needsParts: string[] = [];
    const company = this.extractString(data, [
      'company',
      'organization',
      'company_name',
      'companyName',
      'org',
    ]);

    if (company) {
      needsParts.push(`Company: ${company}`);
    }

    if (notes) {
      needsParts.push(notes);
    }

    needsParts.push(`[Raw webhook payload]: ${JSON.stringify(data)}`);

    // Map source to valid enum
    const validSources = ['WEBSITE', 'REFERRAL', 'COLD_OUTREACH', 'SOCIAL_MEDIA', 'PAID_AD', 'EVENT', 'PARTNER', 'OTHER'];
    const mappedSource = validSources.includes(source.toUpperCase()) ? source.toUpperCase() : 'OTHER';

    return {
      name,
      emails: {
        primaryEmail: email,
        additionalEmails: [],
      },
      phones: {
        primaryPhoneNumber: phone,
        primaryPhoneCountryCode: '',
        additionalPhones: [],
      },
      source: mappedSource,
      sourceDetail: null,
      needs: needsParts.join('\n'),
      stage: 'NEW',
      priority: 'MEDIUM',
      enrichmentStatus: 'NOT_ENRICHED',
      // Pre-qualification funnel fields → dedicated lead columns.
      extra: {
        telegram: this.extractString(data, ['telegram']) ?? null,
        companyRevenue:
          this.extractString(data, ['monthly_volume', 'volume', 'revenue']) ??
          null,
        industry: this.extractString(data, ['category', 'industry']) ?? null,
        based: this.extractString(data, ['based']) ?? null,
        country: this.extractString(data, ['country']) ?? null,
        ssnItin: this.extractString(data, ['ssn_or_itin', 'ssn_itin']) ?? null,
        usLlc: this.extractString(data, ['us_llc']) ?? null,
        activeFor: this.extractString(data, ['active_for', 'tenure']) ?? null,
        sellsTo: this.extractString(data, ['sells_to', 'audience']) ?? null,
        website: this.extractString(data, ['website']) ?? null,
        preferredContact:
          this.extractString(data, ['preferred_contact', 'comm']) ?? null,
      },
    };
  }

  private async persistLead(
    leadData: LeadCreateData,
    workspaceId: string,
  ): Promise<{ leadId: string }> {
    const schema = getWorkspaceSchemaName(workspaceId);
    const leadId = uuidv4();

    // Map source to valid enum
    const validSources = ['WEBSITE', 'REFERRAL', 'COLD_OUTREACH', 'SOCIAL_MEDIA', 'PAID_AD', 'EVENT', 'PARTNER', 'OTHER'];
    const source = validSources.includes(leadData.source?.toUpperCase())
      ? leadData.source.toUpperCase()
      : 'OTHER';

    const x = leadData.extra ?? {};

    await this.dataSource.query(
      `INSERT INTO "${schema}"."lead" (
        "id", "name",
        "emailsPrimaryEmail", "emailsAdditionalEmails",
        "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
        "source", "sourceDetail", "needs",
        "stage", "priority", "enrichmentStatus",
        "telegram", "companyRevenue", "industry",
        "based", "country", "ssnItin", "usLlc", "activeFor", "sellsTo", "website", "preferredContact",
        "position", "createdAt", "updatedAt"
      ) VALUES (
        $1, $2,
        $3, $4::jsonb,
        $5, $6, '', '[]'::jsonb,
        $7, $8, $9,
        $10, $11, $12,
        $13, $14, $15,
        $16, $17, $18, $19, $20, $21, $22, $23,
        0, NOW(), NOW()
      )`,
      [
        leadId,
        leadData.name,
        leadData.emails.primaryEmail,
        JSON.stringify(leadData.emails.additionalEmails),
        leadData.phones.primaryPhoneNumber,
        leadData.phones.primaryPhoneCountryCode,
        source,
        leadData.sourceDetail,
        leadData.needs,
        leadData.stage,
        leadData.priority,
        leadData.enrichmentStatus,
        x.telegram ?? null,
        x.companyRevenue ?? null,
        x.industry ?? null,
        x.based ?? null,
        x.country ?? null,
        x.ssnItin ?? null,
        x.usLlc ?? null,
        x.activeFor ?? null,
        x.sellsTo ?? null,
        x.website ?? null,
        x.preferredContact ?? null,
      ],
    );

    this.logger.log(
      `Created lead ${leadId} in workspace ${workspaceId} from webhook (source: ${source})`,
    );

    return { leadId };
  }

  private buildNeedsField(
    needs: string | undefined,
    metadata: Record<string, unknown> | undefined,
  ): string {
    const parts: string[] = [];

    if (needs) {
      parts.push(needs);
    }

    if (metadata && Object.keys(metadata).length > 0) {
      parts.push(`[Affiliate metadata]: ${JSON.stringify(metadata)}`);
    }

    return parts.join('\n') || '';
  }

  private extractString(
    data: Record<string, unknown>,
    keys: string[],
  ): string | undefined {
    for (const key of keys) {
      const value = data[key];

      if (typeof value === 'string' && value.trim().length > 0) {
        return value.trim();
      }
    }

    return undefined;
  }

  private buildNameFromParts(data: Record<string, unknown>): string | undefined {
    const firstName = this.extractString(data, [
      'first_name',
      'firstName',
      'fname',
    ]);
    const lastName = this.extractString(data, [
      'last_name',
      'lastName',
      'lname',
    ]);

    if (firstName || lastName) {
      return [firstName, lastName].filter(Boolean).join(' ');
    }

    return undefined;
  }
}
