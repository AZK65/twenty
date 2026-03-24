// Cal.com BOOKING_CREATED webhook payload shape.
// See: https://cal.com/docs/core-features/webhooks

export type CalcomAttendee = {
  email: string;
  name: string;
  firstName?: string;
  lastName?: string;
  timeZone?: string;
  language?: { locale: string };
  utcOffset?: number;
};

export type CalcomOrganizer = {
  id: number;
  name: string;
  email: string;
  username?: string;
  timeZone?: string;
  language?: { locale: string };
};

export type CalcomBookingPayload = {
  uid: string;
  bookingId?: number;
  title: string;
  type: string;
  description?: string;
  additionalNotes?: string;
  startTime: string;
  endTime: string;
  organizer: CalcomOrganizer;
  attendees: CalcomAttendee[];
  location?: string;
  videoCallData?: {
    type: string;
    url: string;
    id?: string;
    password?: string;
  };
  // metadata can carry affiliate/referral tracking via Cal.com booking page URL params
  // e.g. cal.com/user/meeting?metadata[affiliateId]=aff_123&metadata[referralId]=ref_456
  metadata: Record<string, unknown>;
  // responses from custom questions on the booking form
  responses: Record<string, { label?: string; value?: unknown; isHidden?: boolean } | string>;
  customInputs?: Record<string, unknown>;
  eventTypeId?: number;
  requiresConfirmation?: boolean;
};

export type CalcomWebhookEvent = {
  triggerEvent: 'BOOKING_CREATED' | 'BOOKING_RESCHEDULED' | 'BOOKING_CANCELLED' | string;
  createdAt: string;
  payload: CalcomBookingPayload;
};
