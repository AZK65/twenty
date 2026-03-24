import { Injectable, Logger } from '@nestjs/common';

import { v4 as uuidv4 } from 'uuid';

import { GlobalWorkspaceOrmManager } from 'src/engine/twenty-orm/global-workspace-datasource/global-workspace-orm.manager';
import { buildSystemAuthContext } from 'src/engine/twenty-orm/utils/build-system-auth-context.util';
import {
  type CalcomBookingPayload,
  type CalcomWebhookEvent,
} from 'src/modules/lead/dtos/calcom-webhook.dto';
import { LeadWorkspaceEntity } from 'src/modules/lead/standard-objects/lead.workspace-entity';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';

// Handles inbound Cal.com BOOKING_CREATED webhooks.
// 1. Finds or creates a lead from the attendee + affiliate/referral data
// 2. Transitions the lead to MEETING_SCHEDULED
// 3. Fires the REN webhook with affiliate ID, referral ID, and MRR

@Injectable()
export class CalcomWebhookService {
  private readonly logger = new Logger(CalcomWebhookService.name);

  constructor(
    private readonly globalWorkspaceOrmManager: GlobalWorkspaceOrmManager,
    private readonly renWebhookService: RenWebhookService,
  ) {}

  async handleBookingCreated(
    event: CalcomWebhookEvent,
    workspaceId: string,
  ): Promise<{ leadId: string; isNew: boolean }> {
    const booking = event.payload;
    const attendee = booking.attendees[0];

    if (!attendee) {
      throw new Error('No attendee found in Cal.com booking payload');
    }

    const { affiliateId, referralId } = this.extractTrackingIds(booking);

    this.logger.log(
      `Cal.com booking "${booking.uid}" for ${attendee.email}, affiliateId=${affiliateId ?? 'none'}, referralId=${referralId ?? 'none'}`,
    );

    const authContext = buildSystemAuthContext(workspaceId);

    const result = await this.globalWorkspaceOrmManager.executeInWorkspaceContext(
      async () => {
        const leadRepository =
          await this.globalWorkspaceOrmManager.getRepository(
            workspaceId,
            LeadWorkspaceEntity,
            { shouldBypassPermissionChecks: true },
          );

        // Try to find an existing lead by attendee email
        let lead = await this.findLeadByEmail(leadRepository, attendee.email);
        let isNew = false;

        if (lead) {
          // Update existing lead: set stage and attach affiliate data if not already set
          const updates: Partial<LeadWorkspaceEntity> = {
            stage: 'MEETING_SCHEDULED',
          };

          if (affiliateId && !lead.sourceDetail) {
            updates.sourceDetail = this.buildSourceDetail(affiliateId, referralId);
          }

          if (!lead.sourceDetail && affiliateId) {
            updates.source = 'PARTNER';
          }

          await leadRepository.update(lead.id, updates as Partial<LeadWorkspaceEntity>);

          this.logger.log(
            `Updated existing lead ${lead.id} to MEETING_SCHEDULED for Cal.com booking ${booking.uid}`,
          );
        } else {
          // Create new lead from Cal.com attendee
          isNew = true;
          const leadId = uuidv4();
          const firstName = attendee.firstName ?? attendee.name?.split(' ')[0] ?? '';
          const lastName = attendee.lastName ?? attendee.name?.split(' ').slice(1).join(' ') ?? '';

          await leadRepository.insert({
            id: leadId,
            name: attendee.name || `${firstName} ${lastName}`.trim() || attendee.email,
            emails: {
              primaryEmail: attendee.email,
              additionalEmails: [],
            },
            phones: {
              primaryPhoneNumber: this.extractPhone(booking) ?? '',
              primaryPhoneCountryCode: '',
              additionalPhones: [],
            },
            source: affiliateId ? 'PARTNER' : 'CAL_COM',
            sourceDetail: this.buildSourceDetail(affiliateId, referralId),
            needs: this.buildNeedsFromBooking(booking),
            stage: 'MEETING_SCHEDULED',
            priority: 'MEDIUM',
            enrichmentStatus: 'NOT_ENRICHED',
          } as Partial<LeadWorkspaceEntity>);

          lead = { id: leadId } as LeadWorkspaceEntity;

          this.logger.log(
            `Created new lead ${leadId} from Cal.com booking ${booking.uid}`,
          );
        }

        return { leadId: lead.id, isNew };
      },
      authContext,
    );

    // Fire the REN webhook — the lead is now in MEETING_SCHEDULED with affiliate data
    // We fire it directly here instead of relying on the DB event listener
    // because the listener may not resolve the full affiliate context from a raw update.
    const mrr = this.extractMrr(booking);

    await this.renWebhookService.sendCallBooked({
      event: 'call.booked',
      leadId: result.leadId,
      leadName: attendee.name ?? attendee.email,
      affiliateId: affiliateId ?? null,
      referralId: referralId ?? null,
      mrr: mrr?.amount ?? null,
      mrrCurrency: mrr?.currency ?? null,
      callBookedAt: booking.startTime,
      workspaceId,
      timestamp: new Date().toISOString(),
    });

    return result;
  }

  // Extracts affiliateId and referralId from Cal.com booking data.
  // Cal.com passes URL query params into metadata:
  //   cal.com/user/meeting?metadata[affiliateId]=aff_123&metadata[referralId]=ref_456
  // Also checks responses (custom booking questions) and customInputs.
  private extractTrackingIds(
    booking: CalcomBookingPayload,
  ): { affiliateId: string | null; referralId: string | null } {
    let affiliateId: string | null = null;
    let referralId: string | null = null;

    // 1. Check metadata (URL params passed to Cal.com booking page)
    if (booking.metadata) {
      affiliateId = this.asString(booking.metadata.affiliateId)
        ?? this.asString(booking.metadata.affiliate_id)
        ?? this.asString(booking.metadata.aff_id)
        ?? this.asString(booking.metadata.ref);

      referralId = this.asString(booking.metadata.referralId)
        ?? this.asString(booking.metadata.referral_id)
        ?? this.asString(booking.metadata.rid);
    }

    // 2. Check responses (custom questions on the booking form)
    if (booking.responses) {
      if (!affiliateId) {
        affiliateId = this.extractResponseValue(booking.responses, [
          'affiliateId', 'affiliate_id', 'aff_id', 'affiliate',
        ]);
      }

      if (!referralId) {
        referralId = this.extractResponseValue(booking.responses, [
          'referralId', 'referral_id', 'referral', 'rid',
        ]);
      }
    }

    // 3. Check customInputs (legacy Cal.com custom fields)
    if (booking.customInputs && (!affiliateId || !referralId)) {
      if (!affiliateId) {
        affiliateId = this.asString(booking.customInputs.affiliateId)
          ?? this.asString(booking.customInputs.affiliate_id);
      }

      if (!referralId) {
        referralId = this.asString(booking.customInputs.referralId)
          ?? this.asString(booking.customInputs.referral_id);
      }
    }

    return { affiliateId, referralId };
  }

  private extractResponseValue(
    responses: Record<string, { label?: string; value?: unknown; isHidden?: boolean } | string>,
    keys: string[],
  ): string | null {
    for (const key of keys) {
      const response = responses[key];

      if (!response) continue;

      if (typeof response === 'string') {
        return response;
      }

      if (response.value && typeof response.value === 'string') {
        return response.value;
      }
    }

    return null;
  }

  // Extract MRR from metadata or responses
  private extractMrr(
    booking: CalcomBookingPayload,
  ): { amount: number; currency: string } | null {
    const mrrRaw = this.asString(booking.metadata?.mrr)
      ?? this.asString(booking.metadata?.monthly_recurring_revenue)
      ?? this.extractResponseValue(booking.responses ?? {}, ['mrr', 'monthly_recurring_revenue']);

    if (!mrrRaw) return null;

    const amount = parseFloat(mrrRaw);

    if (isNaN(amount)) return null;

    const currency = this.asString(booking.metadata?.currency)
      ?? this.asString(booking.metadata?.mrr_currency)
      ?? 'USD';

    return { amount, currency };
  }

  private extractPhone(booking: CalcomBookingPayload): string | null {
    // Check responses for phone number
    const phoneKeys = ['attendeePhoneNumber', 'phone', 'phone_number', 'phoneNumber'];

    for (const key of phoneKeys) {
      const response = booking.responses?.[key];

      if (!response) continue;

      if (typeof response === 'string') return response;

      if (response.value && typeof response.value === 'string') {
        return response.value;
      }
    }

    return null;
  }

  private buildNeedsFromBooking(booking: CalcomBookingPayload): string {
    const parts: string[] = [];

    parts.push(`Cal.com booking: ${booking.title}`);

    if (booking.description) {
      parts.push(booking.description);
    }

    if (booking.additionalNotes) {
      parts.push(booking.additionalNotes);
    }

    parts.push(`Scheduled: ${booking.startTime} – ${booking.endTime}`);

    if (booking.location) {
      parts.push(`Location: ${booking.location}`);
    }

    return parts.join('\n');
  }

  private buildSourceDetail(
    affiliateId: string | null,
    referralId: string | null,
  ): string | null {
    if (!affiliateId && !referralId) return null;

    if (affiliateId && referralId) {
      return JSON.stringify({ affiliateId, referralId });
    }

    return affiliateId ?? referralId ?? null;
  }

  private async findLeadByEmail(
    repository: { find: (options: unknown) => Promise<LeadWorkspaceEntity[]> },
    email: string,
  ): Promise<LeadWorkspaceEntity | null> {
    // Search leads whose primary email matches
    const leads = await repository.find({
      where: {
        emails: { primaryEmail: email },
      },
      take: 1,
    });

    return leads[0] ?? null;
  }

  private asString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    return null;
  }
}
