import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  type CalcomBookingPayload,
  type CalcomWebhookEvent,
} from 'src/modules/lead/dtos/calcom-webhook.dto';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';

// Handles inbound Cal.com BOOKING_CREATED webhooks.
// 1. Finds or creates a lead from the attendee + affiliate/referral data
// 2. Transitions the lead to MEETING_SCHEDULED
// 3. Fires the REN webhook with affiliate ID, referral ID, and MRR

@Injectable()
export class CalcomWebhookService {
  private readonly logger = new Logger(CalcomWebhookService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
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
    const schema = getWorkspaceSchemaName(workspaceId);

    this.logger.log(
      `Cal.com booking "${booking.uid}" for ${attendee.email}, affiliateId=${affiliateId ?? 'none'}, referralId=${referralId ?? 'none'}`,
    );

    // Check if lead already exists by email
    const existing = await this.dataSource.query(
      `SELECT id, "sourceDetail", stage FROM "${schema}"."lead" WHERE "emailsPrimaryEmail" = $1 LIMIT 1`,
      [attendee.email],
    );

    let leadId: string;
    let isNew: boolean;

    if (existing.length > 0) {
      leadId = existing[0].id;
      isNew = false;

      const updates: string[] = [`"stage" = 'MEETING_SCHEDULED'`];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (affiliateId && !existing[0].sourceDetail) {
        updates.push(`"sourceDetail" = $${paramIndex}`);
        params.push(this.buildSourceDetail(affiliateId, referralId));
        paramIndex++;

        updates.push(`"source" = 'PARTNER'`);
      }

      params.push(leadId);
      await this.dataSource.query(
        `UPDATE "${schema}"."lead" SET ${updates.join(', ')}, "updatedAt" = NOW() WHERE id = $${paramIndex}`,
        params,
      );

      this.logger.log(
        `Updated existing lead ${leadId} to MEETING_SCHEDULED for Cal.com booking ${booking.uid}`,
      );
    } else {
      leadId = uuidv4();
      isNew = true;

      const name = attendee.name
        || [attendee.firstName, attendee.lastName].filter(Boolean).join(' ')
        || attendee.email;
      const phone = this.extractPhone(booking) ?? '';
      const source = affiliateId ? 'PARTNER' : 'OTHER';
      const sourceDetail = this.buildSourceDetail(affiliateId, referralId);
      const needs = this.buildNeedsFromBooking(booking);

      await this.dataSource.query(
        `INSERT INTO "${schema}"."lead" (
          "id", "name",
          "emailsPrimaryEmail", "emailsAdditionalEmails",
          "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
          "source", "sourceDetail", "needs",
          "stage", "priority", "enrichmentStatus",
          "position", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2,
          $3, '[]'::jsonb,
          $4, '', '', '[]'::jsonb,
          $5, $6, $7,
          'MEETING_SCHEDULED', 'HIGH', 'NOT_ENRICHED',
          0, NOW(), NOW()
        )`,
        [leadId, name, attendee.email, phone, source, sourceDetail, needs],
      );

      this.logger.log(
        `Created new lead ${leadId} from Cal.com booking ${booking.uid}`,
      );
    }

    // Fire the REN webhook
    const mrr = this.extractMrr(booking);

    await this.renWebhookService.sendCallBooked({
      event: 'call.booked',
      leadId,
      leadName: attendee.name ?? attendee.email,
      affiliateId: affiliateId ?? null,
      referralId: referralId ?? null,
      mrr: mrr?.amount ?? null,
      mrrCurrency: mrr?.currency ?? null,
      callBookedAt: booking.startTime,
      workspaceId,
      timestamp: new Date().toISOString(),
    });

    return { leadId, isNew };
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

    if (booking.metadata) {
      affiliateId = this.asString(booking.metadata.affiliateId)
        ?? this.asString(booking.metadata.affiliate_id)
        ?? this.asString(booking.metadata.aff_id)
        ?? this.asString(booking.metadata.ref);

      referralId = this.asString(booking.metadata.referralId)
        ?? this.asString(booking.metadata.referral_id)
        ?? this.asString(booking.metadata.rid);
    }

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

  private asString(value: unknown): string | null {
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim();
    }

    return null;
  }
}
