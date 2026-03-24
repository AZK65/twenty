# REN Webhook

REN is an outbound webhook system that notifies subscribers about affiliate-referred leads and their payment lifecycle. It tracks which affiliates drive revenue and signals when to start or stop commission payouts.

---

## Events

| Event | Fires When | Purpose |
|---|---|---|
| `call.booked` | A referred lead books a customer call (stage → `MEETING_SCHEDULED` or `PRE_CALL`) | Notify subscriber that a referral booked a call — includes affiliate ID and expected MRR |
| `customer.status_changed` → `ACTIVE` | Lead stage → `WON` | Notify subscriber to **start affiliate payouts** — customer is paying |
| `customer.status_changed` → `INACTIVE` | Lead stage → `LOST` | Notify subscriber to **stop affiliate payouts** — customer churned |

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `REN_WEBHOOK_URL` | Yes | The URL that receives REN webhook POSTs. If unset, all REN events are silently skipped. |
| `REN_WEBHOOK_SECRET` | No | Shared secret sent in the `x-ren-secret` header for verifying authenticity. |

---

## Headers

Every REN webhook POST includes these headers:

| Header | Value |
|---|---|
| `Content-Type` | `application/json` |
| `X-Ren-Event` | `call.booked` or `customer.status_changed` |
| `x-ren-secret` | Value of `REN_WEBHOOK_SECRET` (omitted if not configured) |

---

## Payloads

### `call.booked`

Sent when a referred lead books a customer call.

```json
{
  "event": "call.booked",
  "leadId": "550e8400-e29b-41d4-a716-446655440000",
  "leadName": "John Doe",
  "affiliateId": "aff_123",
  "referralId": "ref_456",
  "mrr": 299.00,
  "mrrCurrency": "USD",
  "callBookedAt": "2026-03-25T10:00:00.000Z",
  "workspaceId": "ws-001",
  "timestamp": "2026-03-23T12:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `event` | `string` | Always `"call.booked"` |
| `leadId` | `string` | UUID of the lead record |
| `leadName` | `string` | Full name of the lead |
| `affiliateId` | `string \| null` | Affiliate who referred this lead |
| `referralId` | `string \| null` | Referral tracking ID |
| `mrr` | `number \| null` | Monthly recurring revenue (dollars) |
| `mrrCurrency` | `string \| null` | Currency code (e.g. `"USD"`) |
| `callBookedAt` | `string` | ISO 8601 timestamp of the scheduled call |
| `workspaceId` | `string` | Workspace that owns the lead |
| `timestamp` | `string` | ISO 8601 timestamp when the webhook fired |

### `customer.status_changed`

Sent when a customer's payment status changes.

```json
{
  "event": "customer.status_changed",
  "leadId": "550e8400-e29b-41d4-a716-446655440000",
  "leadName": "John Doe",
  "affiliateId": "aff_123",
  "referralId": "ref_456",
  "previousStatus": null,
  "newStatus": "ACTIVE",
  "mrr": 299.00,
  "mrrCurrency": "USD",
  "reason": "Deal won — customer converted to paying",
  "workspaceId": "ws-001",
  "timestamp": "2026-03-23T14:00:00.000Z"
}
```

| Field | Type | Description |
|---|---|---|
| `event` | `string` | Always `"customer.status_changed"` |
| `leadId` | `string` | UUID of the lead record |
| `leadName` | `string` | Full name of the lead |
| `affiliateId` | `string \| null` | Affiliate who referred this lead |
| `referralId` | `string \| null` | Referral tracking ID |
| `previousStatus` | `"ACTIVE" \| "INACTIVE" \| null` | Status before the change (`null` if first transition) |
| `newStatus` | `"ACTIVE" \| "INACTIVE"` | New payment status |
| `mrr` | `number \| null` | Monthly recurring revenue (dollars) |
| `mrrCurrency` | `string \| null` | Currency code |
| `reason` | `string \| null` | Human-readable reason for the change |
| `workspaceId` | `string` | Workspace that owns the lead |
| `timestamp` | `string` | ISO 8601 timestamp when the webhook fired |

**Status values:**

| Status | Meaning | Affiliate action |
|---|---|---|
| `ACTIVE` | Customer is paying | Start commission payouts |
| `INACTIVE` | Customer stopped paying | Stop commission payouts |

---

## Subscribing

Set `REN_WEBHOOK_URL` to your endpoint and build a receiver:

```typescript
app.post('/api/ren-webhook', (req, res) => {
  // Verify secret
  if (req.headers['x-ren-secret'] !== process.env.EXPECTED_REN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { event } = req.body;

  if (event === 'call.booked') {
    const { affiliateId, referralId, mrr, leadName } = req.body;
    // A referred lead booked a call
    // Log it, notify the affiliate, update dashboards, etc.
  }

  if (event === 'customer.status_changed') {
    const { affiliateId, newStatus, mrr } = req.body;

    if (newStatus === 'ACTIVE') {
      // Customer is paying — start affiliate commission payouts
    }

    if (newStatus === 'INACTIVE') {
      // Customer churned — stop affiliate commission payouts
    }
  }

  res.status(200).json({ received: true });
});
```

---

## Cal.com Integration

REN works with Cal.com to automatically capture affiliate-referred bookings.

### Setup

1. In Cal.com, go to **Settings → Webhooks → Add**
2. Set subscriber URL:
   ```
   https://your-twenty-server.com/webhooks/leads/calcom?workspaceId=YOUR_WORKSPACE_ID
   ```
3. Select trigger: **Booking Created**
4. Set the `x-webhook-secret` header to your `LEAD_WEBHOOK_SECRET` value

### Passing affiliate data

Append tracking params to your Cal.com booking link:

```
https://cal.com/yourteam/meeting?metadata[affiliateId]=aff_123&metadata[referralId]=ref_456&metadata[mrr]=299
```

Cal.com passes `metadata` fields through in its webhook payload. The receiver extracts `affiliateId`, `referralId`, and `mrr` automatically.

Affiliate data can also come from:
- Cal.com **custom questions** on the booking form (field names: `affiliateId`, `referralId`)
- Cal.com **custom inputs** (legacy, field names: `affiliateId`, `referralId`)

### What happens on booking

1. Cal.com fires `BOOKING_CREATED` to your endpoint
2. Twenty finds an existing lead by email or creates a new one
3. Lead stage is set to `MEETING_SCHEDULED`
4. Affiliate/referral IDs are stored on the lead's `sourceDetail` field
5. REN `call.booked` webhook fires immediately with affiliate + MRR data

---

## Full Lifecycle Example

```
1. Affiliate shares link:
   cal.com/team/demo?metadata[affiliateId]=aff_123&metadata[referralId]=ref_456

2. Lead books a call
   → Cal.com fires BOOKING_CREATED
   → Twenty creates lead (stage: MEETING_SCHEDULED, sourceDetail: aff_123)
   → REN fires: call.booked { affiliateId: "aff_123", mrr: null }

3. Sales rep wins the deal, sets estimatedValue to $299/mo, moves stage to WON
   → REN fires: customer.status_changed { newStatus: "ACTIVE", affiliateId: "aff_123", mrr: 299 }
   → Subscriber starts paying affiliate commission on $299 MRR

4. Customer cancels 6 months later, rep moves stage to LOST
   → REN fires: customer.status_changed { newStatus: "INACTIVE", affiliateId: "aff_123", mrr: 299 }
   → Subscriber stops affiliate commission payouts
```

---

## Files

| File | Purpose |
|---|---|
| `dtos/webhook.dto.ts` | `RenWebhookPayload`, `RenStatusWebhookPayload`, `RenCustomerStatus` types |
| `dtos/calcom-webhook.dto.ts` | Cal.com inbound webhook payload types |
| `services/ren-webhook.service.ts` | Outbound HTTP delivery for both REN events |
| `services/calcom-webhook.service.ts` | Cal.com booking receiver — find/create lead, fire REN |
| `listeners/ren-call-booked.listener.ts` | Fires `call.booked` on stage → `MEETING_SCHEDULED` / `PRE_CALL` |
| `listeners/ren-customer-status.listener.ts` | Fires `customer.status_changed` on stage → `WON` / `LOST` |
| `controllers/lead-webhook.controller.ts` | `POST /webhooks/leads/calcom` endpoint |
| `guards/webhook-auth.guard.ts` | Verifies `x-webhook-secret` header (env: `LEAD_WEBHOOK_SECRET`) |
