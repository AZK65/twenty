import { Injectable, Logger } from '@nestjs/common';

import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = 'openai/gpt-4o-mini';
const MAX_TOOL_ITERATIONS = 5;

type ToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

type Message =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'find_records',
      description:
        'Fuzzy-search across leads, clients (people), or losses by name, email, or phone. Returns up to 10 candidates.',
      parameters: {
        type: 'object',
        properties: {
          type: {
            type: 'string',
            enum: ['lead', 'client', 'loss'],
            description: 'Which CRM table to search',
          },
          query: {
            type: 'string',
            description: 'Search term (name fragment, email, or phone)',
          },
        },
        required: ['type', 'query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_record_details',
      description:
        'Get detailed info for a specific record by id, including notes, tasks, and recent timeline activities.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['lead', 'client', 'loss'] },
          id: { type: 'string', description: 'Record UUID' },
        },
        required: ['type', 'id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_records',
      description:
        'List records with optional filters. Returns up to 25 results.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['lead', 'client', 'loss'] },
          stage: {
            type: 'string',
            description: 'Lead stage filter (e.g. WON, LOST, NEW)',
          },
          assigneeName: {
            type: 'string',
            description: 'Filter by assigned workspace member name',
          },
          source: {
            type: 'string',
            description: 'Source filter (e.g. TELEGRAM, REFERRAL)',
          },
          createdSinceDays: {
            type: 'integer',
            description: 'Only records created in the last N days',
          },
          priority: { type: 'string', enum: ['LOW', 'MEDIUM', 'HIGH'] },
        },
        required: ['type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pipeline_stats',
      description:
        'Returns counts and total estimated value of leads grouped by stage.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_workspace_member',
      description: 'Look up a workspace member by name or email.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' } },
        required: ['query'],
      },
    },
  },
];

@Injectable()
export class TelegramQAService {
  private readonly logger = new Logger(TelegramQAService.name);

  constructor(
    @InjectDataSource()
    private readonly dataSource: DataSource,
  ) {}

  isConfigured(): boolean {
    return Boolean(process.env.OPENROUTER_API_KEY);
  }

  async answer(question: string, schema: string): Promise<string> {
    const apiKey = process.env.OPENROUTER_API_KEY;

    if (!apiKey) return 'AI is not configured (OPENROUTER_API_KEY missing).';

    const messages: Message[] = [
      {
        role: 'system',
        content:
          'You are a CRM assistant for Apptics Sales CRM. Answer questions about leads, clients, and losses. ' +
          'Use the provided tools to look up data — do not guess. Keep answers concise and Telegram-friendly: ' +
          'short paragraphs, bold names, no markdown headers. If you cannot find data, say so. ' +
          'Stage values: NEW, CONTACTED, QUALIFIED, PRE_CALL, MEETING_SCHEDULED, PROPOSAL, NEGOTIATION, WON, LOST.',
      },
      { role: 'user', content: question },
    ];

    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await this.callLLM(messages, apiKey);

      if (!response) return 'Sorry, I could not reach the AI service.';

      const toolCalls = response.tool_calls ?? [];

      if (toolCalls.length === 0) {
        return (response.content ?? '').trim() || 'No answer.';
      }

      messages.push({
        role: 'assistant',
        content: response.content,
        tool_calls: toolCalls,
      });

      for (const call of toolCalls) {
        const result = await this.executeTool(
          call.function.name,
          this.safeParse(call.function.arguments),
          schema,
        );

        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: JSON.stringify(result).slice(0, 6000),
        });
      }
    }

    return 'Stopped after too many tool calls — please refine your question.';
  }

  // --- LLM call ---

  private async callLLM(
    messages: Message[],
    apiKey: string,
  ): Promise<{ content: string | null; tool_calls?: ToolCall[] } | null> {
    try {
      const response = await fetch(OPENROUTER_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          messages,
          tools: TOOLS,
          max_tokens: 1500,
        }),
        signal: AbortSignal.timeout(30_000),
      });

      const data = (await response.json()) as {
        choices?: Array<{
          message?: { content: string | null; tool_calls?: ToolCall[] };
        }>;
      };

      const msg = data.choices?.[0]?.message;

      if (!msg) return null;

      return { content: msg.content ?? null, tool_calls: msg.tool_calls };
    } catch (error) {
      this.logger.warn(
        `LLM call failed: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  private safeParse(json: string): Record<string, unknown> {
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  // --- Tool dispatcher ---

  private async executeTool(
    name: string,
    args: Record<string, unknown>,
    schema: string,
  ): Promise<unknown> {
    try {
      switch (name) {
        case 'find_records':
          return this.findRecords(
            schema,
            String(args.type ?? 'lead'),
            String(args.query ?? ''),
          );
        case 'get_record_details':
          return this.getRecordDetails(
            schema,
            String(args.type ?? 'lead'),
            String(args.id ?? ''),
          );
        case 'list_records':
          return this.listRecords(schema, args);
        case 'pipeline_stats':
          return this.pipelineStats(schema);
        case 'get_workspace_member':
          return this.getWorkspaceMember(schema, String(args.query ?? ''));
        default:
          return { error: `Unknown tool ${name}` };
      }
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  // --- Tool implementations ---

  private tableFor(type: string): string {
    if (type === 'client') return 'person';
    if (type === 'loss') return '_loss';
    return 'lead';
  }

  private async findRecords(
    schema: string,
    type: string,
    query: string,
  ): Promise<unknown> {
    const table = this.tableFor(type);
    const q = `%${query.toLowerCase()}%`;

    if (type === 'client') {
      return this.dataSource.query(
        `SELECT id,
                TRIM(CONCAT(COALESCE("nameFirstName",''),' ',COALESCE("nameLastName",''))) AS name,
                "emailsPrimaryEmail" AS email,
                "phonesPrimaryPhoneNumber" AS phone
         FROM "${schema}"."${table}"
         WHERE "deletedAt" IS NULL
           AND (LOWER(COALESCE("nameFirstName",'') || ' ' || COALESCE("nameLastName",'')) LIKE $1
             OR LOWER(COALESCE("emailsPrimaryEmail",'')) LIKE $1
             OR COALESCE("phonesPrimaryPhoneNumber",'') LIKE $1)
         LIMIT 10`,
        [q],
      );
    }

    return this.dataSource.query(
      `SELECT id, name,
              "emailsPrimaryEmail" AS email,
              "phonesPrimaryPhoneNumber" AS phone,
              ${table === 'lead' ? 'stage, priority,' : ''}
              "createdAt"
       FROM "${schema}"."${table}"
       WHERE "deletedAt" IS NULL
         AND (LOWER(COALESCE(name,'')) LIKE $1
           OR LOWER(COALESCE("emailsPrimaryEmail",'')) LIKE $1
           OR COALESCE("phonesPrimaryPhoneNumber",'') LIKE $1)
       LIMIT 10`,
      [q],
    );
  }

  private async getRecordDetails(
    schema: string,
    type: string,
    id: string,
  ): Promise<unknown> {
    const table = this.tableFor(type);

    let recordCols = '*';

    if (type === 'lead') {
      recordCols = `id, name, stage, priority, source, "sourceDetail", needs,
        "estimatedValueAmountMicros", "estimatedValueCurrencyCode",
        "nextFollowUpDate", "emailsPrimaryEmail", "phonesPrimaryPhoneNumber",
        "assignedToId", "ownerId", "createdAt", "updatedAt"`;
    }

    const main = await this.dataSource.query(
      `SELECT ${recordCols} FROM "${schema}"."${table}" WHERE id = $1 AND "deletedAt" IS NULL LIMIT 1`,
      [id],
    );

    if (!main[0]) return { error: 'Record not found' };

    const targetCol =
      type === 'client'
        ? 'targetPersonId'
        : type === 'loss'
          ? 'targetLossId'
          : 'targetLeadId';

    let notes: unknown[] = [];
    let tasks: unknown[] = [];
    let timeline: unknown[] = [];

    try {
      notes = await this.dataSource.query(
        `SELECT n.id, n.title, LEFT(COALESCE(n."bodyV2Markdown",''), 800) AS body, n."createdAt"
         FROM "${schema}"."noteTarget" nt
         JOIN "${schema}"."note" n ON n.id = nt."noteId"
         WHERE nt."${targetCol}" = $1 AND n."deletedAt" IS NULL
         ORDER BY n."createdAt" DESC LIMIT 5`,
        [id],
      );
    } catch {
      // column may not exist for custom objects
    }

    try {
      tasks = await this.dataSource.query(
        `SELECT t.id, t.title, t.status, t."dueAt", t."createdAt"
         FROM "${schema}"."taskTarget" tt
         JOIN "${schema}"."task" t ON t.id = tt."taskId"
         WHERE tt."${targetCol}" = $1 AND t."deletedAt" IS NULL
         ORDER BY t."createdAt" DESC LIMIT 10`,
        [id],
      );
    } catch {
      // ignore
    }

    try {
      timeline = await this.dataSource.query(
        `SELECT name, properties, "happensAt"
         FROM "${schema}"."timelineActivity"
         WHERE "${targetCol}" = $1
         ORDER BY "happensAt" DESC LIMIT 10`,
        [id],
      );
    } catch {
      // ignore
    }

    return { record: main[0], notes, tasks, timeline };
  }

  private async listRecords(
    schema: string,
    args: Record<string, unknown>,
  ): Promise<unknown> {
    const type = String(args.type ?? 'lead');
    const table = this.tableFor(type);
    const where: string[] = [`"deletedAt" IS NULL`];
    const params: unknown[] = [];

    if (table === 'lead' && args.stage) {
      params.push(String(args.stage).toUpperCase());
      where.push(`stage = $${params.length}`);
    }

    if (table === 'lead' && args.priority) {
      params.push(String(args.priority).toUpperCase());
      where.push(`priority = $${params.length}`);
    }

    if (table === 'lead' && args.source) {
      params.push(String(args.source));
      where.push(`source = $${params.length}`);
    }

    if (args.createdSinceDays) {
      params.push(Number(args.createdSinceDays));
      where.push(
        `"createdAt" >= NOW() - ($${params.length} || ' days')::interval`,
      );
    }

    if (table === 'lead' && args.assigneeName) {
      const member = await this.findWorkspaceMember(
        schema,
        String(args.assigneeName),
      );

      if (member) {
        params.push(member.id);
        where.push(`"assignedToId" = $${params.length}`);
      } else {
        return { error: `No workspace member matching "${args.assigneeName}"` };
      }
    }

    const cols =
      table === 'lead'
        ? `id, name, stage, priority, source, "estimatedValueAmountMicros" AS "amountMicros", "estimatedValueCurrencyCode" AS currency, "createdAt"`
        : table === '_loss'
          ? `id, name, "createdAt"`
          : `id, TRIM(CONCAT(COALESCE("nameFirstName",''),' ',COALESCE("nameLastName",''))) AS name, "emailsPrimaryEmail" AS email, "createdAt"`;

    return this.dataSource.query(
      `SELECT ${cols} FROM "${schema}"."${table}"
       WHERE ${where.join(' AND ')}
       ORDER BY "createdAt" DESC LIMIT 25`,
      params,
    );
  }

  private async pipelineStats(schema: string): Promise<unknown> {
    return this.dataSource.query(
      `SELECT stage,
              COUNT(*)::int AS count,
              COALESCE(SUM("estimatedValueAmountMicros"),0)::bigint AS "totalValueMicros",
              COALESCE(MAX("estimatedValueCurrencyCode"),'USD') AS currency
       FROM "${schema}"."lead"
       WHERE "deletedAt" IS NULL
       GROUP BY stage
       ORDER BY count DESC`,
    );
  }

  private async getWorkspaceMember(
    schema: string,
    query: string,
  ): Promise<unknown> {
    return this.findWorkspaceMember(schema, query);
  }

  private async findWorkspaceMember(
    schema: string,
    query: string,
  ): Promise<{ id: string; name: string; email: string | null } | null> {
    const rows = await this.dataSource.query(
      `SELECT id,
              TRIM(CONCAT(COALESCE("nameFirstName",''),' ',COALESCE("nameLastName",''))) AS name,
              "userEmail" AS email
       FROM "${schema}"."workspaceMember"
       WHERE LOWER(TRIM(CONCAT(COALESCE("nameFirstName",''),' ',COALESCE("nameLastName","")))) LIKE LOWER($1)
          OR LOWER(COALESCE("nameFirstName",'')) LIKE LOWER($1)
          OR LOWER(COALESCE("nameLastName",'')) LIKE LOWER($1)
          OR LOWER(COALESCE("userEmail",'')) LIKE LOWER($1)
       LIMIT 1`,
      [`%${query}%`],
    );

    return rows[0] ?? null;
  }
}
