import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  type CalcomBookingPayload,
  type CalcomWebhookEvent,
} from 'src/modules/lead/dtos/calcom-webhook.dto';
import { LeadEventEmitterService } from 'src/modules/lead/services/lead-event-emitter.service';
import { RenWebhookService } from 'src/modules/lead/services/ren-webhook.service';
import { SendblueService } from 'src/modules/lead/services/sendblue.service';

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
    private readonly sendblueService: SendblueService,
    private readonly leadEventEmitterService: LeadEventEmitterService,
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

    // Pre-qualification fields the funnel form passes as Cal booking metadata.
    const meta = (booking.metadata ?? {}) as Record<string, unknown>;
    const m = (k: string): string | null => this.asString(meta[k]);
    const pq: Record<string, string | null> = {
      companyRevenue:
        m('monthly_volume') ??
        this.extractResponseValue(booking.responses ?? {}, [
          'revenue', 'Revenue', 'Current-Revenue', 'current_revenue', 'monthlyRevenue',
        ]),
      industry: m('category'),
      telegram: m('telegram'),
      based: m('based'),
      country: m('country'),
      ssnItin: m('ssn_or_itin'),
      usLlc: m('us_llc'),
      activeFor: m('active_for'),
      sellsTo: m('sells_to'),
      website: m('website'),
      preferredContact: m('preferred_contact'),
    };

    // Attribution — paid ads vs organic, platform, campaign, click ids. The
    // funnel form passes these as metadata (first-touch values via its cookie).
    const attr: Record<string, string | null> = {
      leadSource: m('lead_source'),
      adPlatform: m('ad_platform'),
      utmSource: m('utm_source'),
      utmMedium: m('utm_medium'),
      utmCampaign: m('utm_campaign'),
      gclid: m('gclid'),
      fbclid: m('fbclid'),
    };

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

      const meetingLink = this.extractMeetingLink(booking);
      const notes = this.extractNotes(booking);

      const updates: string[] = [
        `"stage" = 'MEETING_SCHEDULED'`,
        `"nextFollowUpDate" = $1`,
      ];
      const params: unknown[] = [booking.startTime];
      let paramIndex = 2;

      if (meetingLink) {
        updates.push(`"linkedinLinkPrimaryLinkLabel" = 'Meeting Link'`);
        updates.push(`"linkedinLinkPrimaryLinkUrl" = $${paramIndex}`);
        params.push(meetingLink);
        paramIndex++;
      }

      // Enrich the lead's columns from the funnel metadata (only when present).
      for (const [col, val] of Object.entries(pq)) {
        if (val) {
          updates.push(`"${col}" = $${paramIndex}`);
          params.push(val);
          paramIndex++;
        }
      }

      if (notes) {
        updates.push(`"needs" = $${paramIndex}`);
        params.push(notes);
        paramIndex++;
      }

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
        || m('name')
        || attendee.email;
      const phone = this.extractPhone(booking) ?? m('phone') ?? '';
      const calSource =
        m('source') ??
        this.extractResponseValue(booking.responses ?? {}, ['source', 'Source']);
      const source = affiliateId ? 'PARTNER' : (calSource ? this.mapSource(calSource) : 'CAL_COM');
      const sourceDetail = this.buildSourceDetail(affiliateId, referralId) ?? calSource;
      const needs = this.extractNotes(booking);
      const meetingLink = this.extractMeetingLink(booking);

      await this.dataSource.query(
        `INSERT INTO "${schema}"."lead" (
          "id", "name",
          "emailsPrimaryEmail", "emailsAdditionalEmails",
          "phonesPrimaryPhoneNumber", "phonesPrimaryPhoneCountryCode", "phonesPrimaryPhoneCallingCode", "phonesAdditionalPhones",
          "source", "sourceDetail", "needs",
          "stage", "priority", "enrichmentStatus",
          "companyRevenue", "industry", "telegram",
          "based", "country", "ssnItin", "usLlc", "activeFor", "sellsTo", "website", "preferredContact",
          "nextFollowUpDate",
          "linkedinLinkPrimaryLinkLabel", "linkedinLinkPrimaryLinkUrl", "linkedinLinkSecondaryLinks",
          "position", "createdAt", "updatedAt"
        ) VALUES (
          $1, $2,
          $3, '[]'::jsonb,
          $4, '', '', '[]'::jsonb,
          $5, $6, $7,
          'MEETING_SCHEDULED', 'HIGH', 'NOT_ENRICHED',
          $8, $9, $10,
          $11, $12, $13, $14, $15, $16, $17, $18,
          $19,
          'Meeting Link', $20, '[]'::jsonb,
          0, NOW(), NOW()
        )`,
        [
          leadId, name, attendee.email, phone, source, sourceDetail, needs,
          pq.companyRevenue, pq.industry, pq.telegram,
          pq.based, pq.country, pq.ssnItin, pq.usLlc, pq.activeFor, pq.sellsTo, pq.website, pq.preferredContact,
          booking.startTime, meetingLink,
        ],
      );

      this.logger.log(
        `Created new lead ${leadId} from Cal.com booking ${booking.uid}`,
      );

      // Emit event so real-time subscriptions pick it up
      await this.leadEventEmitterService.emitLeadCreated(
        leadId,
        { name, emailsPrimaryEmail: attendee.email, stage: 'MEETING_SCHEDULED' },
        workspaceId,
      );
    }

    // Persist attribution onto the lead (covers both new + existing leads).
    const attrCols = Object.entries(attr).filter(([, v]) => v);

    if (attrCols.length > 0) {
      const sets = attrCols.map(([col], i) => `"${col}" = $${i + 1}`);
      const vals: unknown[] = attrCols.map(([, v]) => v);

      vals.push(leadId);
      await this.dataSource.query(
        `UPDATE "${schema}"."lead" SET ${sets.join(', ')}, "updatedAt" = NOW() WHERE id = $${vals.length}`,
        vals,
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

    // Send iMessage welcome via Sendblue
    const phone = this.extractPhone(booking) ?? '';

    if (phone) {
      await this.sendblueService.sendCallBookedMessage(
        leadId,
        attendee.name ?? attendee.email,
        phone,
        booking.startTime,
        booking.uid,
        workspaceId,
      );
    }

    // Notify the sales Telegram bot with the booked time + qualification.
    try {
      const tz = (attendee as { timeZone?: string }).timeZone || 'UTC';
      let when = booking.startTime;
      try {
        when =
          new Intl.DateTimeFormat('en-US', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: tz,
          }).format(new Date(booking.startTime)) + ` (${tz})`;
      } catch {
        // keep ISO string
      }
      const notifyName = attendee.name || m('name') || attendee.email;
      const notifyPhone = this.extractPhone(booking) ?? m('phone') ?? '';
      const line = (l: string, v: string | null | undefined) =>
        v ? `${l}: ${v}` : null;

      // Where the lead came from. The funnel form passes lead_source +
      // lead_source_detail as metadata; direct-calendar bookings have neither,
      // so they're treated as organic.
      const leadSource =
        m('lead_source') ?? (affiliateId ? 'Partner' : 'Organic');
      const leadSourceDetail =
        m('lead_source_detail') ??
        this.buildSourceDetail(affiliateId, referralId) ??
        null;
      const srcEmoji =
        leadSource === 'Paid ads' ? '🟣' : leadSource === 'Partner' ? '🤝' : '🟢';
      const sourceLine = `${srcEmoji} Source: ${leadSource}${
        leadSourceDetail ? ` (${leadSourceDetail})` : ''
      }`;

      const text = [
        '📅 Call booked — Apptics',
        '',
        sourceLine,
        line('Name', notifyName),
        line('Email', attendee.email),
        line('Phone', notifyPhone),
        line('When', when),
        line('Volume', pq.companyRevenue),
        line('Sells', pq.industry),
        line(
          'Based',
          pq.based ? `${pq.based}${pq.country ? ` (${pq.country})` : ''}` : null,
        ),
        line('US LLC', pq.usLlc),
        line('SSN/ITIN', pq.ssnItin),
        line('Active', pq.activeFor),
        line('Audience', pq.sellsTo),
        line('Website', pq.website),
        line('Preferred', pq.preferredContact),
        line('Telegram', pq.telegram),
        `CRM lead: ${leadId}`,
      ]
        .filter((x) => x !== null)
        .join('\n');
      await this.notifyAdminsTelegram(text);
    } catch (e) {
      this.logger.warn(
        `Telegram booking notify failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    return { leadId, isNew };
  }

  // Sends a plain-text message to every TELEGRAM_ADMIN_CHAT_ID via the bot.
  private async notifyAdminsTelegram(text: string): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    const raw = process.env.TELEGRAM_ADMIN_CHAT_ID;

    if (!token || !raw) return;

    const chatIds = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    await Promise.all(
      chatIds.map((chatId) =>
        fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            text,
            disable_web_page_preview: true,
          }),
        }).catch(() => undefined),
      ),
    );
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
    // 1. Cal.com top-level fields (smsReminderNumber is the built-in
    //    "Phone number (Text notifications)" field).
    const topLevel =
      this.asString(
        (booking as unknown as Record<string, unknown>).smsReminderNumber,
      ) ??
      this.asString(
        (booking as unknown as Record<string, unknown>).attendeePhoneNumber,
      );

    if (topLevel) return topLevel;

    // 2. Known response keys (custom fields)
    const knownKeys = [
      'smsReminderNumber',
      'attendeePhoneNumber',
      'phone',
      'phone_number',
      'phoneNumber',
    ];

    for (const key of knownKeys) {
      const response = booking.responses?.[key];

      if (!response) continue;
      if (typeof response === 'string') return response;
      if (response.value && typeof response.value === 'string') {
        return response.value;
      }
    }

    // 3. Fallback: scan all responses for any key/label that looks phone-ish.
    const responses = booking.responses ?? {};

    for (const [key, response] of Object.entries(responses)) {
      if (!/(phone|sms|mobile|whatsapp)/i.test(key)) continue;

      if (typeof response === 'string') return response;
      if (
        response &&
        typeof response === 'object' &&
        'value' in response &&
        typeof (response as { value?: unknown }).value === 'string'
      ) {
        return (response as { value: string }).value;
      }
    }

    return null;
  }

  private extractNotes(booking: CalcomBookingPayload): string {
    const parts: string[] = [];

    if (booking.description) {
      parts.push(booking.description);
    }

    if (booking.additionalNotes) {
      parts.push(booking.additionalNotes);
    }

    const notes = this.extractResponseValue(booking.responses ?? {}, ['notes', 'Notes', 'additional_notes']);

    if (notes) {
      parts.push(notes);
    }

    return parts.join('\n') || '';
  }

  private extractMeetingLink(booking: CalcomBookingPayload): string {
    // Check metadata for video call URL
    if (booking.videoCallData?.url) {
      return booking.videoCallData.url;
    }

    const metaUrl = this.asString((booking.metadata as Record<string, unknown>)?.videoCallUrl);

    if (metaUrl) {
      return metaUrl;
    }

    // Fall back to location if it's a URL
    if (booking.location && booking.location.startsWith('http')) {
      return booking.location;
    }

    return '';
  }

  // Map Cal.com source response to valid lead source enum
  private mapSource(source: string | null): string {
    if (!source) return 'OTHER';
    const lower = source.toLowerCase();

    if (lower.includes('referral') || lower.includes('affiliate')) return 'REFERRAL';
    if (lower.includes('social') || lower.includes('instagram') || lower.includes('twitter') || lower.includes('tiktok')) return 'SOCIAL_MEDIA';
    if (lower.includes('website') || lower.includes('google') || lower.includes('seo')) return 'WEBSITE';
    if (lower.includes('ad') || lower.includes('paid') || lower.includes('ppc')) return 'PAID_AD';
    if (lower.includes('cold') || lower.includes('outreach') || lower.includes('outbound')) return 'COLD_OUTREACH';
    if (lower.includes('event') || lower.includes('conference')) return 'EVENT';
    if (lower.includes('partner')) return 'PARTNER';

    return 'OTHER';
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
