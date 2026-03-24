import { Injectable, Logger } from '@nestjs/common';

import { v4 as uuidv4 } from 'uuid';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  type AffiliateWebhookPayload,
  type LeadCreateData,
} from 'src/modules/lead/dtos/webhook.dto';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

@Injectable()
export class LeadWebhookService {
  private readonly logger = new Logger(LeadWebhookService.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
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

    const company = this.extractString(data, [
      'company',
      'organization',
      'company_name',
      'companyName',
      'org',
    ]);

    const source = this.extractString(data, [
      'source',
      'utm_source',
      'utmSource',
      'referrer',
      'channel',
    ]) ?? 'WEBHOOK';

    const notes = this.extractString(data, [
      'notes',
      'message',
      'description',
      'comment',
      'comments',
    ]);

    // Build needs field from notes and raw payload
    const needsParts: string[] = [];

    if (company) {
      needsParts.push(`Company: ${company}`);
    }

    if (notes) {
      needsParts.push(notes);
    }

    needsParts.push(`[Raw webhook payload]: ${JSON.stringify(data)}`);

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
      source,
      sourceDetail: null,
      needs: needsParts.join('\n'),
      stage: 'NEW',
      priority: 'MEDIUM',
      enrichmentStatus: 'NOT_ENRICHED',
    };
  }

  private async persistLead(
    leadData: LeadCreateData,
    workspaceId: string,
  ): Promise<{ leadId: string }> {
    const authContext = buildSystemAuthContext(workspaceId);
    const leadId = uuidv4();

    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const leadRepository =
          await this.globalWorkspaceOrmManager.getRepository<LeadWorkspaceEntity>(
            workspaceId,
            'lead',
            { shouldBypassPermissionChecks: true },
          );

        await leadRepository.insert({
          id: leadId,
          ...leadData,
        } as Partial<LeadWorkspaceEntity>);

        this.logger.log(
          `Created lead ${leadId} in workspace ${workspaceId} from webhook (source: ${leadData.source})`,
        );
      },
      authContext,
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
