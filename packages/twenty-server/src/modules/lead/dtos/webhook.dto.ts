export type AffiliateWebhookPayload = {
  name: string;
  email?: string;
  phone?: string;
  company?: string;
  source?: string;
  sourceDetail?: string;
  needs?: string;
  affiliateId?: string;
  metadata?: Record<string, unknown>;
};

export type GenericWebhookPayload = Record<string, unknown>;

export type WebhookResponse = {
  success: boolean;
  leadId?: string;
  error?: string;
};

export type LeadCreateData = {
  name: string;
  emails: {
    primaryEmail: string;
    additionalEmails: string[];
  };
  phones: {
    primaryPhoneNumber: string;
    primaryPhoneCountryCode: string;
    additionalPhones: never[];
  };
  source: string;
  sourceDetail: string | null;
  needs: string | null;
  stage: string;
  priority: string;
  enrichmentStatus: string;
  // Optional funnel/pre-qualification columns, keyed by exact lead column name.
  extra?: Record<string, string | null>;
};

// REN webhook: outbound payload sent when a customer call is booked
export type RenWebhookPayload = {
  event: 'call.booked';
  leadId: string;
  leadName: string;
  affiliateId: string | null;
  referralId: string | null;
  mrr: number | null;
  mrrCurrency: string | null;
  callBookedAt: string;
  workspaceId: string;
  timestamp: string;
};

// REN status webhook: outbound payload sent when a customer's payment status changes.
//   ACTIVE   — customer is paying (subscription active)
//   INACTIVE — customer stopped paying (churned / cancelled)
export type RenCustomerStatus = 'ACTIVE' | 'INACTIVE';

export type RenStatusWebhookPayload = {
  event: 'customer.status_changed';
  leadId: string;
  leadName: string;
  affiliateId: string | null;
  referralId: string | null;
  previousStatus: RenCustomerStatus | null;
  newStatus: RenCustomerStatus;
  mrr: number | null;
  mrrCurrency: string | null;
  reason: string | null;
  workspaceId: string;
  timestamp: string;
};

export type RenWebhookResponse = {
  success: boolean;
  statusCode: number | null;
  error?: string;
};
