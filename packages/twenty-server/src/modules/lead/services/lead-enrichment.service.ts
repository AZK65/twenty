import { Injectable, Logger } from '@nestjs/common';

import { isDefined } from 'twenty-shared/utils';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import { type LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';

export type LeadEnrichmentData = {
  industry: string | null;
  companySize: string | null;
  companyRevenue: string | null;
  linkedinUrl: string | null;
};

export type EnrichmentApiResponse = {
  success: boolean;
  data: LeadEnrichmentData | null;
  error?: string;
};

// Stub enrichment provider interface for future API integration
// Replace this with a real provider (Apollo, Clearbit, etc.)
const fetchEnrichmentData = async (
  domain: string,
): Promise<EnrichmentApiResponse> => {
  // TODO: Replace with actual enrichment API call
  // Example providers: Apollo, Clearbit, ZoomInfo, Hunter.io
  //
  // const response = await fetch(
  //   `https://api.apollo.io/api/v1/organizations/enrich?domain=${encodeURIComponent(domain)}`,
  //   {
  //     method: 'GET',
  //     headers: {
  //       'Content-Type': 'application/json',
  //       Authorization: `Bearer ${process.env.ENRICHMENT_API_KEY ?? ''}`,
  //     },
  //   },
  // );
  // const data = await response.json();

  Logger.warn(
    `Enrichment API stub called for domain "${domain}". Replace with a real provider.`,
    'LeadEnrichmentService',
  );

  return {
    success: false,
    data: null,
    error: 'Enrichment API not configured. Replace stub with a real provider.',
  };
};

const extractDomainFromEmail = (email: string): string | undefined => {
  const parts = email.split('@');

  if (parts.length !== 2) {
    return undefined;
  }

  const domain = parts[1];

  // Skip common free email providers
  const freeProviders = [
    'gmail.com',
    'yahoo.com',
    'hotmail.com',
    'outlook.com',
    'aol.com',
    'icloud.com',
    'mail.com',
    'protonmail.com',
    'zoho.com',
  ];

  if (freeProviders.includes(domain.toLowerCase())) {
    return undefined;
  }

  return domain;
};

@Injectable()
export class LeadEnrichmentService {
  private readonly logger = new Logger(LeadEnrichmentService.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
  ) {}

  async enrichLead(leadId: string, workspaceId: string): Promise<void> {
    const authContext = buildSystemAuthContext(workspaceId);

    await this.globalWorkspaceOrmManager.executeInWorkspaceContext(async () => {
      const leadRepository =
        await this.globalWorkspaceOrmManager.getRepository<LeadWorkspaceEntity>(
          workspaceId,
          'lead',
          { shouldBypassPermissionChecks: true },
        );

      const lead = await leadRepository.findOne({
        where: { id: leadId },
      });

      if (!isDefined(lead)) {
        this.logger.warn(
          `Lead ${leadId} not found in workspace ${workspaceId}`,
        );

        return;
      }

      const primaryEmail = lead.emails?.primaryEmail;

      if (!isDefined(primaryEmail) || primaryEmail.trim() === '') {
        this.logger.log(
          `Lead ${leadId} has no primary email, skipping enrichment`,
        );

        await leadRepository.update(
          { id: leadId },
          { enrichmentStatus: 'SKIPPED' },
        );

        return;
      }

      const domain = extractDomainFromEmail(primaryEmail);

      if (!isDefined(domain)) {
        this.logger.log(
          `Lead ${leadId} has a free email provider, skipping enrichment`,
        );

        await leadRepository.update(
          { id: leadId },
          { enrichmentStatus: 'SKIPPED' },
        );

        return;
      }

      this.logger.log(
        `Enriching lead ${leadId} with domain "${domain}"`,
      );

      try {
        const response = await fetchEnrichmentData(domain);

        if (!response.success || !isDefined(response.data)) {
          this.logger.warn(
            `Enrichment failed for lead ${leadId}: ${response.error ?? 'unknown error'}`,
          );

          await leadRepository.update(
            { id: leadId },
            { enrichmentStatus: 'FAILED' },
          );

          return;
        }

        const updateData: Partial<LeadWorkspaceEntity> = {
          enrichmentStatus: 'ENRICHED',
        };

        if (isDefined(response.data.industry)) {
          updateData.industry = response.data.industry;
        }

        if (isDefined(response.data.companySize)) {
          updateData.companySize = response.data.companySize;
        }

        if (isDefined(response.data.companyRevenue)) {
          updateData.companyRevenue = response.data.companyRevenue;
        }

        if (isDefined(response.data.linkedinUrl)) {
          updateData.linkedinLink = {
            primaryLinkUrl: response.data.linkedinUrl,
            primaryLinkLabel: 'LinkedIn',
            secondaryLinks: null,
          };
        }

        await leadRepository.update({ id: leadId }, updateData);

        this.logger.log(
          `Successfully enriched lead ${leadId} with fields: ${Object.keys(updateData).join(', ')}`,
        );
      } catch (error) {
        this.logger.error(
          `Unexpected error enriching lead ${leadId}: ${error instanceof Error ? error.message : String(error)}`,
        );

        await leadRepository.update(
          { id: leadId },
          { enrichmentStatus: 'FAILED' },
        );
      }
    }, authContext);
  }
}
