# Apptics Sales CRM Telegram Bot — User Guide

## What this bot does

The bot lets the team add and manage leads from inside Telegram chats. It auto-syncs Telegram conversations into the CRM, generates AI summaries, and notifies admins of important events.

---

## Setup (one-time)

1. **Open Telegram** and find the Apptics CRM bot (link/handle from your team admin).
2. Send `/start` in a DM with the bot.
3. Send `/myid` — the bot replies with your chat ID. Forward that ID to your admin so you get added to admin notifications.

---

## Commands

All commands work in **DMs with the bot** and in **group chats** the bot is in.

### `/lead Name email phone`

Creates a new lead in the CRM. Email and phone are optional but recommended.

**Examples:**

```
/lead John Doe john@gmail.com +15551234567
/lead Sarah Khan sarah@company.io
/lead Antoine Le Brun
```

If used inside a group chat, the group is auto-linked to that lead.

### `/link`

With no argument — links the current group chat to the **most recently created lead**.

`/link <email>` — links the group to a specific lead, found by their primary email.

**Examples:**

```
/link
/link john@gmail.com
```

After linking, every message in the group gets buffered for AI summarization.

### `/summary`

Forces an immediate AI summary of unprocessed messages in the linked group. The summary updates the lead's notes (the **Needs** field in CRM) and adds a timeline entry.

Without `/summary`, the bot auto-summarizes every **30 minutes** if there are new messages.

### `/myid`

Replies with your numeric chat ID. Used for getting added to admin notifications.

### `/help` or `/start`

Shows the command list.

---

## Automatic behaviors

### Auto-linking groups → leads

When the bot is added to a group, it tries to match the group's title to a lead's name in the CRM. Examples:

- Group "John Doe - Apptics" → linked to lead "John Doe"
- Group "Jake | Onboarding" → linked to lead "Jake …"

If auto-link fails, use `/link` manually.

### Auto-buffering

Every non-command message in a linked group is stored in the CRM's `telegramMessage` table.

### Auto-summary (every 30 min)

- If there are unprocessed messages, the bot calls GPT-4o-mini via OpenRouter.
- Summary covers: people in the chat, key topics/decisions, action items + deadlines, important details about the lead.
- Existing summary is **merged in** so context isn't lost across sessions.
- Result is saved to the lead's **Needs** field, plus a timeline entry titled "Conversation summary updated".

### Admin notifications

Admin chat IDs (configured server-side) get DMs on:

- ✅ Lead added
- 🔗 Group linked to lead
- 📋 Summary updated
- ⚠️ Validation issues (missing details, no lead found)
- ❌ Errors creating leads

Multiple admins are supported — IDs are comma-separated in the env config.

---

## What gets stored in the CRM

| Action          | CRM record                                                                |
| --------------- | ------------------------------------------------------------------------- |
| `/lead`         | New row in **Lead** table with stage `NEW`, source `TELEGRAM`             |
| Group linked    | Row in `telegramGroupLead` mapping `chatId` → `leadId`                    |
| Each message    | Row in `telegramMessage`                                                  |
| Auto-summary    | Updates lead's `needs` + adds `timelineActivity` row                      |

---

## Tips

- **Group naming:** Use the lead's name in the group title for auto-link to work. Separators like `&`, `|`, `-`, `,` are stripped, and noise words like "apptics", "crm", "sales", "team", "support" are filtered out.
- **Summary won't run** if no lead is linked to the group. Use `/link` first.
- **Lead already linked?** `/link` returns "✅ This group is already linked." — no double-linking.
- **Email validation:** Email is matched by regex (`name@domain.tld`). Invalid emails are silently dropped from the lead.

---

## Quick troubleshooting

| Problem                              | Likely cause                                                  |
| ------------------------------------ | ------------------------------------------------------------- |
| `/lead` says "needs at least a name" | Empty after stripping email/phone                             |
| `/link <email>` does nothing         | No lead found with that email                                 |
| `/summary` says "no new messages"    | Either nothing buffered, or all messages already summarized   |
| Bot doesn't respond at all           | Bot not in this chat, or webhook down — ping admin            |
