import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceSchemaName } from 'src/engine/workspace-datasource/utils/get-workspace-schema-name.util';
import {
  type TldvMeeting,
  TldvService,
} from 'src/modules/tldv/services/tldv.service';

// Handles TLDV MeetingReady webhooks.
// Strategy: match invitee emails against lead.emailsPrimaryEmail first,
// then fuzzy-match meeting name / invitee names against lead.name.
// On match, fetch AI notes via API and create a Note attached to the lead +
// a timeline entry.

type TldvWebhookPayload = {
  id?: string;
  event?: string;
  data?: TldvMeeting;
  executedAt?: string;
};

// Emails that belong to the Apptics team — never match these to a lead.
const TEAM_EMAIL_DOMAINS = ['apptics.ai'];

@Injectable()
export class TldvWebhookService {
  private readonly logger = new Logger(TldvWebhookService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tldvService: TldvService,
  ) {}

  async handleMeetingReady(
    payload: TldvWebhookPayload,
    workspaceId: string,
  ): Promise<{ handled: boolean; leadId?: string; reason?: string }> {
    const meeting = payload.data;

    if (!meeting?.id) {
      return { handled: false, reason: 'Missing meeting in payload' };
    }

    const schema = getWorkspaceSchemaName(workspaceId);
    const leadMetaId = await this.getObjectMetadataId(workspaceId, 'lead');
    const noteMetaId = await this.getObjectMetadataId(workspaceId, 'note');

    if (!leadMetaId || !noteMetaId) {
      return {
        handled: false,
        reason: 'Workspace object metadata not found',
      };
    }

    // Try matching: invitee emails → invitee names → meeting name.
    const lead = await this.matchLead(schema, meeting);

    if (!lead) {
      this.logger.log(
        `No lead matched for TLDV meeting ${meeting.id} ("${meeting.name}")`,
      );

      return { handled: false, reason: 'No matching lead' };
    }

    // Fetch AI notes + highlights for note body. Degrade gracefully when absent.
    const [notes, highlights] = await Promise.all([
      this.tldvService.getNotes(meeting.id),
      this.tldvService.getHighlights(meeting.id),
    ]);

    const noteId = uuidv4();
    const noteTitle = this.buildNoteTitle(meeting);
    const noteMarkdown = this.buildNoteMarkdown(meeting, notes, highlights);
    const noteBlocknote = this.markdownToBlocknote(noteMarkdown);

    // Stamp the note with the meeting's actual time so chronological
    // sorting in the UI lines up with reality.
    const meetingHappenedAt = this.parseDate(meeting.happenedAt) ?? new Date();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."note" (
        "id", "title", "bodyV2Markdown", "bodyV2Blocknote",
        "createdAt", "updatedAt", "position",
        "createdBySource", "createdByName",
        "updatedBySource", "updatedByName"
      ) VALUES (
        $1, $2, $3, $4,
        $5, $5, 0,
        'API', 'TLDV',
        'API', 'TLDV'
      )`,
      [noteId, noteTitle, noteMarkdown, noteBlocknote, meetingHappenedAt.toISOString()],
    );

    // Link the note to the lead via noteTarget.
    await this.dataSource.query(
      `INSERT INTO "${schema}"."noteTarget" (
        "id", "noteId", "targetLeadId",
        "createdAt", "updatedAt", "position",
        "createdBySource", "createdByName",
        "updatedBySource", "updatedByName"
      ) VALUES (
        $1, $2, $3,
        NOW(), NOW(), 0,
        'API', 'TLDV',
        'API', 'TLDV'
      )`,
      [uuidv4(), noteId, lead.id],
    );

    // Dedicated timeline entry for the meeting itself (separate from the
    // automatic note-created timeline entry).
    const happensAt = this.parseDate(meeting.happenedAt) ?? new Date();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."timelineActivity" (
        "id", "happensAt", "name", "properties",
        "linkedRecordCachedName", "linkedRecordId", "linkedObjectMetadataId",
        "targetLeadId",
        "createdAt", "updatedAt", "position"
      ) VALUES (
        $1, $2, 'lead.meeting_completed', $3,
        '', $4, $5,
        $4,
        NOW(), NOW(), 0
      )`,
      [
        uuidv4(),
        happensAt.toISOString(),
        JSON.stringify({
          tldvMeetingId: meeting.id,
          tldvMeetingName: meeting.name,
          tldvUrl: meeting.url,
          durationSeconds: meeting.duration,
          organizer: meeting.organizer,
          invitees: meeting.invitees,
          noteId,
          hasAiSummary: Boolean(notes?.markdownContent || notes?.topics?.length),
        }),
        lead.id,
        leadMetaId,
      ],
    );

    this.logger.log(
      `TLDV meeting ${meeting.id} attached to lead ${lead.id} (${lead.name})`,
    );

    return { handled: true, leadId: lead.id };
  }

  private async matchLead(
    schema: string,
    meeting: TldvMeeting,
  ): Promise<{ id: string; name: string } | null> {
    // 1. Match against invitee emails (excluding our team domains).
    const externalEmails = (meeting.invitees ?? [])
      .map((i) => i.email?.trim().toLowerCase())
      .filter((e): e is string => Boolean(e))
      .filter((e) => !this.isTeamEmail(e));

    if (externalEmails.length > 0) {
      const byEmail = await this.dataSource.query(
        `SELECT id, name FROM "${schema}"."lead"
         WHERE LOWER("emailsPrimaryEmail") = ANY($1::text[])
         LIMIT 1`,
        [externalEmails],
      );

      if (byEmail[0]) return byEmail[0];
    }

    // 2. Match against invitee names (strip our team).
    const externalNames = (meeting.invitees ?? [])
      .filter((i) => {
        const email = (i.email ?? '').toLowerCase();

        return i.name && i.name.trim() && !this.isTeamEmail(email);
      })
      .map((i) => i.name!.trim());

    for (const name of externalNames) {
      const byName = await this.findLeadByName(schema, name);

      if (byName) return byName;
    }

    // 3. Parse lead name out of meeting title: "Apptics.ai - Call With X" etc.
    const titleName = this.extractNameFromMeetingTitle(meeting.name);

    if (titleName) {
      const byTitle = await this.findLeadByName(schema, titleName);

      if (byTitle) return byTitle;
    }

    return null;
  }

  private async findLeadByName(
    schema: string,
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    const trimmed = name.trim();

    if (trimmed.length < 2) return null;

    // Exact match first, then startswith (cheapest meaningful fuzzy).
    const exact = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE LOWER(name) = LOWER($1)
       LIMIT 1`,
      [trimmed],
    );

    if (exact[0]) return exact[0];

    const firstWord = trimmed.split(/\s+/)[0];

    if (firstWord.length < 2) return null;

    const starts = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE LOWER(name) LIKE LOWER($1) || ' %'
         OR LOWER(name) LIKE LOWER($1)
       LIMIT 1`,
      [firstWord],
    );

    return starts[0] ?? null;
  }

  private extractNameFromMeetingTitle(title: string): string | null {
    // "Apptics.ai - Call With Adrien" → "Adrien"
    const patterns = [
      /call\s+with\s+([a-zA-Z][a-zA-Z\s]+)$/i,
      /^apptics.*[x|-]\s+([a-zA-Z][a-zA-Z\s]+)$/i,
      /([a-zA-Z]+)\s+[x|-]\s+apptics/i,
    ];

    for (const re of patterns) {
      const match = title.match(re);

      if (match?.[1]) return match[1].trim();
    }

    return null;
  }

  private isTeamEmail(email: string): boolean {
    return TEAM_EMAIL_DOMAINS.some((d) => email.endsWith(`@${d}`));
  }

  private buildNoteTitle(meeting: TldvMeeting): string {
    const date = this.parseDate(meeting.happenedAt);
    const dateStr = date ? date.toLocaleDateString('en-US') : '';

    return dateStr ? `${meeting.name} — ${dateStr}` : meeting.name;
  }

  private buildNoteMarkdown(
    meeting: TldvMeeting,
    notes: { markdownContent: string | null; topics: Array<{ title: string; summary: string }> } | null,
    highlights: { data: Array<{ text?: string }> } | null,
  ): string {
    const parts: string[] = [];

    // Prefer full markdownContent (has sections + timestamp deep-links).
    // Fall back to topics only if markdownContent is empty.
    if (notes?.markdownContent) {
      parts.push(notes.markdownContent);
    } else if (notes?.topics && notes.topics.some((t) => t.summary?.trim())) {
      parts.push('## AI Summary\n');
      for (const topic of notes.topics) {
        if (!topic.summary?.trim()) continue;
        parts.push(`### ${topic.title}\n${topic.summary}\n`);
      }
    }

    if (highlights?.data && highlights.data.length > 0) {
      parts.push('\n## Highlights\n');
      for (const h of highlights.data) {
        if (h.text) parts.push(`- ${h.text}`);
      }
    }

    if (parts.length === 0) {
      parts.push(`Meeting **${meeting.name}** completed on ${meeting.happenedAt}.\n`);
      parts.push('_AI notes/highlights not generated for this meeting._\n');
    }

    parts.push('\n## Details\n');
    if (meeting.duration) {
      parts.push(`- **Duration:** ${Math.round(meeting.duration / 60)} min`);
    }
    if (meeting.organizer?.name) {
      parts.push(`- **Organizer:** ${meeting.organizer.name} (${meeting.organizer.email})`);
    }
    if (meeting.invitees && meeting.invitees.length > 0) {
      const list = meeting.invitees
        .map((i) => (i.name ? `${i.name} (${i.email})` : i.email))
        .filter(Boolean)
        .join(', ');

      parts.push(`- **Attendees:** ${list}`);
    }
    if (meeting.url) parts.push(`- **TLDV link:** ${meeting.url}`);

    return parts.join('\n');
  }

  private markdownToBlocknote(markdown: string): string {
    // Light-weight markdown → BlockNote converter. Supports:
    //  - # / ## / ### headings (levels 1-3)
    //  - `- [ ] item`   → checkListItem
    //  - `- item`       → bulletListItem
    //  - `1. item`      → numberedListItem
    //  - blank line     → skipped
    //  - everything else → paragraph
    // Inline [label](url) is converted to a link mark; **bold** → bold.
    const lines = markdown.split('\n');
    const blocks: unknown[] = [];

    const makeContent = (text: string): unknown[] => {
      const out: unknown[] = [];
      const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
      let lastIdx = 0;
      let match: RegExpExecArray | null;

      while ((match = linkRe.exec(text)) !== null) {
        if (match.index > lastIdx) {
          out.push({
            type: 'text',
            text: text.slice(lastIdx, match.index),
            styles: {},
          });
        }
        out.push({
          type: 'link',
          href: match[2],
          content: [{ type: 'text', text: match[1], styles: {} }],
        });
        lastIdx = match.index + match[0].length;
      }

      if (lastIdx < text.length) {
        out.push({ type: 'text', text: text.slice(lastIdx), styles: {} });
      }

      if (out.length === 0) {
        out.push({ type: 'text', text, styles: {} });
      }

      return out;
    };

    const makeBlock = (
      type: string,
      content: unknown[],
      extraProps: Record<string, unknown> = {},
    ) => ({
      id: uuidv4(),
      type,
      props: {
        backgroundColor: 'default',
        textColor: 'default',
        textAlignment: 'left',
        ...extraProps,
      },
      content,
      children: [],
    });

    for (const raw of lines) {
      const line = raw.trimEnd();

      if (!line.trim()) continue;

      let m: RegExpMatchArray | null;

      m = line.match(/^(#{1,3})\s+(.+)$/);
      if (m) {
        const level = m[1].length;

        blocks.push(
          makeBlock('heading', makeContent(m[2].trim()), { level }),
        );
        continue;
      }

      m = line.match(/^\s*-\s+\[\s*[xX ]?\s*\]\s+(.+)$/);
      if (m) {
        blocks.push(makeBlock('checkListItem', makeContent(m[1].trim()), {
          checked: false,
        }));
        continue;
      }

      m = line.match(/^\s*-\s+(.+)$/);
      if (m) {
        blocks.push(makeBlock('bulletListItem', makeContent(m[1].trim())));
        continue;
      }

      m = line.match(/^\s*\d+\.\s+(.+)$/);
      if (m) {
        blocks.push(makeBlock('numberedListItem', makeContent(m[1].trim())));
        continue;
      }

      blocks.push(makeBlock('paragraph', makeContent(line.trim())));
    }

    if (blocks.length === 0) {
      blocks.push(makeBlock('paragraph', []));
    }

    return JSON.stringify(blocks);
  }

  private async getObjectMetadataId(
    workspaceId: string,
    nameSingular: string,
  ): Promise<string | null> {
    const result = await this.dataSource.query(
      `SELECT id FROM core."objectMetadata"
       WHERE "nameSingular" = $1 AND "workspaceId" = $2 LIMIT 1`,
      [nameSingular, workspaceId],
    );

    return result[0]?.id ?? null;
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);

    return isNaN(parsed.getTime()) ? null : parsed;
  }
}
