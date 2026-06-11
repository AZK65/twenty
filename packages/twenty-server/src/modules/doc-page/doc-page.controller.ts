import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';

type DocPage = {
  slug: string;
  title: string;
  content: string;
  updatedAt: string;
};

// Free-form persisted documents (Note Pad, Cheat Sheet) keyed by slug per
// workspace. One core table, like sales-docs — no metadata migrations.
@Controller('rest/docs')
@UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
export class DocPageController {
  constructor(
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  @Get(':slug')
  async get(@Param('slug') slug: string): Promise<DocPage> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: DocPage[] = await this.coreDataSource.query(
      `SELECT slug, title, content, "updatedAt"
         FROM core.doc_page
        WHERE "workspaceId" = $1 AND slug = $2
        LIMIT 1`,
      [workspace.id, slug],
    );

    return rows[0] ?? { slug, title: '', content: '', updatedAt: '' };
  }

  @Put(':slug')
  async save(
    @Param('slug') slug: string,
    @Body() body: { title?: string; content?: string },
  ): Promise<DocPage> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: DocPage[] = await this.coreDataSource.query(
      `INSERT INTO core.doc_page ("workspaceId", slug, title, content)
         VALUES ($1, $2, $3, $4)
       ON CONFLICT ("workspaceId", slug)
         DO UPDATE SET title = EXCLUDED.title,
                       content = EXCLUDED.content,
                       "updatedAt" = now()
       RETURNING slug, title, content, "updatedAt"`,
      [workspace.id, slug, body.title ?? '', body.content ?? ''],
    );

    return rows[0];
  }
}
