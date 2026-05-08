import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { LeadEventEmitterService } from 'src/modules/lead/services/lead-event-emitter.service';

const KNOWN_STAGES = [
  'NEW',
  'CONTACTED',
  'QUALIFIED',
  'PRE_CALL',
  'MEETING_SCHEDULED',
  'PROPOSAL',
  'NEGOTIATION',
  'WON',
  'LOST',
];

const PRIORITIES = ['LOW', 'MEDIUM', 'HIGH'];

export type LeadInfo = {
  id: string;
  name: string;
  stage: string | null;
  priority: string | null;
  source: string | null;
  needs: string | null;
  estimatedValue: string | null;
  nextFollowUpDate: string | null;
  assignedToName: string | null;
  primaryEmail: string | null;
  primaryPhone: string | null;
};

@Injectable()
export class TelegramLeadOpsService {
  private readonly logger = new Logger(TelegramLeadOpsService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly eventEmitter: LeadEventEmitterService,
  ) {}

  // --- Resolve linked lead from a Telegram chat ---

  async resolveLeadFromChat(
    schema: string,
    chatId: number,
  ): Promise<{ leadId: string; leadName: string } | null> {
    const rows = await this.dataSource.query(
      `SELECT l.id, l.name FROM "${schema}"."telegramGroupLead" g
       JOIN "${schema}"."lead" l ON l.id = g."leadId"
       WHERE g."chatId" = $1 LIMIT 1`,
      [chatId],
    );

    if (!rows[0]) return null;

    return { leadId: rows[0].id, leadName: rows[0].name };
  }

  async findLeadByEmail(
    schema: string,
    email: string,
  ): Promise<{ leadId: string; leadName: string } | null> {
    const rows = await this.dataSource.query(
      `SELECT id, name FROM "${schema}"."lead"
       WHERE LOWER("emailsPrimaryEmail") = LOWER($1) LIMIT 1`,
      [email],
    );

    if (!rows[0]) return null;

    return { leadId: rows[0].id, leadName: rows[0].name };
  }

  // --- Operations ---

  async setStage(
    schema: string,
    workspaceId: string,
    leadId: string,
    stage: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const upper = stage.toUpperCase().replace(/[\s-]+/g, '_');

    if (!KNOWN_STAGES.includes(upper)) {
      return {
        ok: false,
        reason: `Unknown stage "${stage}". Valid: ${KNOWN_STAGES.join(', ')}`,
      };
    }

    const before = await this.dataSource.query(
      `SELECT stage FROM "${schema}"."lead" WHERE id = $1`,
      [leadId],
    );

    await this.dataSource.query(
      `UPDATE "${schema}"."lead" SET stage = $1, "updatedAt" = NOW() WHERE id = $2`,
      [upper, leadId],
    );

    await this.eventEmitter.emitUpdated(
      'lead',
      leadId,
      { stage: before[0]?.stage ?? null },
      { stage: upper },
      workspaceId,
    );

    return { ok: true };
  }

  async setPriority(
    schema: string,
    workspaceId: string,
    leadId: string,
    priority: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    const upper = priority.toUpperCase();

    if (!PRIORITIES.includes(upper)) {
      return {
        ok: false,
        reason: `Unknown priority "${priority}". Valid: ${PRIORITIES.join(', ')}`,
      };
    }

    const before = await this.dataSource.query(
      `SELECT priority FROM "${schema}"."lead" WHERE id = $1`,
      [leadId],
    );

    await this.dataSource.query(
      `UPDATE "${schema}"."lead" SET priority = $1, "updatedAt" = NOW() WHERE id = $2`,
      [upper, leadId],
    );

    await this.eventEmitter.emitUpdated(
      'lead',
      leadId,
      { priority: before[0]?.priority ?? null },
      { priority: upper },
      workspaceId,
    );

    return { ok: true };
  }

  async setValue(
    schema: string,
    workspaceId: string,
    leadId: string,
    amount: number,
    currency: string = 'USD',
  ): Promise<{ ok: boolean; reason?: string }> {
    if (!Number.isFinite(amount) || amount < 0) {
      return { ok: false, reason: 'Amount must be a positive number' };
    }

    const amountMicros = Math.round(amount * 1_000_000);
    const code = currency.toUpperCase();

    await this.dataSource.query(
      `UPDATE "${schema}"."lead"
       SET "estimatedValueAmountMicros" = $1,
           "estimatedValueCurrencyCode" = $2,
           "updatedAt" = NOW()
       WHERE id = $3`,
      [amountMicros, code, leadId],
    );

    await this.eventEmitter.emitUpdated(
      'lead',
      leadId,
      {},
      {
        estimatedValueAmountMicros: amountMicros,
        estimatedValueCurrencyCode: code,
      },
      workspaceId,
    );

    return { ok: true };
  }

  async addNote(
    schema: string,
    workspaceId: string,
    leadId: string,
    title: string,
    body: string,
  ): Promise<{ noteId: string }> {
    const noteId = uuidv4();
    const targetId = uuidv4();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."note" (id, title, "bodyV2Markdown", position, "createdAt", "updatedAt")
       VALUES ($1, $2, $3, 0, NOW(), NOW())`,
      [noteId, title || 'Telegram note', body],
    );

    await this.dataSource.query(
      `INSERT INTO "${schema}"."noteTarget" (id, "noteId", "targetLeadId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [targetId, noteId, leadId],
    );

    // Emit so timeline + notifications fire
    await this.eventEmitter.emitCreated(
      'note',
      noteId,
      { title: title || 'Telegram note', bodyV2Markdown: body },
      workspaceId,
    );
    await this.eventEmitter.emitCreated(
      'noteTarget',
      targetId,
      { noteId, targetLeadId: leadId },
      workspaceId,
    );

    return { noteId };
  }

  async addTask(
    schema: string,
    workspaceId: string,
    leadId: string,
    title: string,
    dueAt: Date | null,
    assigneeWorkspaceMemberId: string | null,
  ): Promise<{ taskId: string }> {
    const taskId = uuidv4();
    const targetId = uuidv4();

    await this.dataSource.query(
      `INSERT INTO "${schema}"."task"
       (id, title, "bodyV2Markdown", status, "dueAt", "assigneeId", position, "createdAt", "updatedAt")
       VALUES ($1, $2, '', 'TODO', $3, $4, 0, NOW(), NOW())`,
      [taskId, title, dueAt?.toISOString() ?? null, assigneeWorkspaceMemberId],
    );

    await this.dataSource.query(
      `INSERT INTO "${schema}"."taskTarget" (id, "taskId", "targetLeadId", "createdAt", "updatedAt")
       VALUES ($1, $2, $3, NOW(), NOW())`,
      [targetId, taskId, leadId],
    );

    await this.eventEmitter.emitCreated(
      'task',
      taskId,
      {
        title,
        dueAt: dueAt?.toISOString() ?? null,
        assigneeId: assigneeWorkspaceMemberId,
      },
      workspaceId,
    );
    await this.eventEmitter.emitCreated(
      'taskTarget',
      targetId,
      { taskId, targetLeadId: leadId },
      workspaceId,
    );

    return { taskId };
  }

  async assignTo(
    schema: string,
    workspaceId: string,
    leadId: string,
    memberQuery: string,
  ): Promise<{ ok: boolean; reason?: string; memberName?: string }> {
    const member = await this.findWorkspaceMember(schema, memberQuery);

    if (!member) {
      return {
        ok: false,
        reason: `No workspace member matching "${memberQuery}"`,
      };
    }

    const before = await this.dataSource.query(
      `SELECT "assignedToId" FROM "${schema}"."lead" WHERE id = $1`,
      [leadId],
    );

    await this.dataSource.query(
      `UPDATE "${schema}"."lead" SET "assignedToId" = $1, "updatedAt" = NOW() WHERE id = $2`,
      [member.id, leadId],
    );

    await this.eventEmitter.emitUpdated(
      'lead',
      leadId,
      { assignedToId: before[0]?.assignedToId ?? null },
      { assignedToId: member.id },
      workspaceId,
    );

    return { ok: true, memberName: member.name };
  }

  async getInfo(schema: string, leadId: string): Promise<LeadInfo | null> {
    const rows = await this.dataSource.query(
      `SELECT
         l.id, l.name, l.stage, l.priority, l.source, l.needs,
         l."estimatedValueAmountMicros" AS "amountMicros",
         l."estimatedValueCurrencyCode" AS "currency",
         l."nextFollowUpDate", l."emailsPrimaryEmail" AS email,
         l."phonesPrimaryPhoneNumber" AS phone,
         TRIM(CONCAT(COALESCE(wm."nameFirstName",''), ' ', COALESCE(wm."nameLastName",''))) AS "assignedToName"
       FROM "${schema}"."lead" l
       LEFT JOIN "${schema}"."workspaceMember" wm ON wm.id = l."assignedToId"
       WHERE l.id = $1 LIMIT 1`,
      [leadId],
    );

    if (!rows[0]) return null;

    const r = rows[0];

    return {
      id: r.id,
      name: r.name,
      stage: r.stage,
      priority: r.priority,
      source: r.source,
      needs: r.needs ? r.needs.slice(0, 1500) : null,
      estimatedValue:
        r.amountMicros != null
          ? `${(Number(r.amountMicros) / 1_000_000).toLocaleString()} ${r.currency ?? ''}`.trim()
          : null,
      nextFollowUpDate: r.nextFollowUpDate
        ? new Date(r.nextFollowUpDate).toISOString()
        : null,
      assignedToName: r.assignedToName?.trim() || null,
      primaryEmail: r.email || null,
      primaryPhone: r.phone || null,
    };
  }

  // --- Helpers ---

  async findWorkspaceMember(
    schema: string,
    query: string,
  ): Promise<{ id: string; name: string } | null> {
    const rows = await this.dataSource.query(
      `SELECT id,
              TRIM(CONCAT(COALESCE("nameFirstName",''), ' ', COALESCE("nameLastName",''))) AS name,
              "nameFirstName", "nameLastName", "userEmail"
       FROM "${schema}"."workspaceMember"
       WHERE LOWER(TRIM(CONCAT(COALESCE("nameFirstName",''), ' ', COALESCE("nameLastName","")))) = LOWER($1)
          OR LOWER("nameFirstName") = LOWER($1)
          OR LOWER("nameLastName") = LOWER($1)
          OR LOWER("userEmail") = LOWER($1)
       LIMIT 1`,
      [query],
    );

    if (!rows[0]) return null;

    return { id: rows[0].id, name: rows[0].name?.trim() || query };
  }
}
