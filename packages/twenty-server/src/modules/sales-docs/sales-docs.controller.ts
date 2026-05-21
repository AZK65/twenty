import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';

import { DataSource } from 'typeorm';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';

type Folder = {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: string;
  updatedAt: string;
};

type DocFile = {
  id: string;
  folderId: string | null;
  name: string;
  fileUrl: string;
  fileSize: number;
  mimeType: string | null;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

// Custom Sales Documents module — folder tree + file links scoped per workspace.
// Bypasses Twenty's objectMetadata so we avoid metadata migrations.
@Controller('rest/sales-docs')
@UseGuards(JwtAuthGuard, WorkspaceAuthGuard, NoPermissionGuard)
export class SalesDocsController {
  constructor(
    @InjectDataSource()
    private readonly coreDataSource: DataSource,
  ) {}

  // -------- Folders --------

  @Get('folders')
  async listFolders(): Promise<Folder[]> {
    const { workspace } = getWorkspaceAuthContext();

    return this.coreDataSource.query(
      `SELECT id, name, "parentId", "createdAt", "updatedAt"
         FROM core.sales_doc_folder
        WHERE "workspaceId" = $1
        ORDER BY name ASC`,
      [workspace.id],
    );
  }

  @Post('folders')
  async createFolder(
    @Body() body: { name: string; parentId?: string | null },
  ): Promise<Folder> {
    const ctx = getWorkspaceAuthContext();
    const workspace = ctx.workspace;
    const userId = 'user' in ctx ? ctx.user.id : null;

    const name = (body.name || '').trim() || 'Untitled folder';
    const parentId = body.parentId || null;

    const rows: Folder[] = await this.coreDataSource.query(
      `INSERT INTO core.sales_doc_folder ("workspaceId", name, "parentId", "createdById")
         VALUES ($1, $2, $3, $4)
       RETURNING id, name, "parentId", "createdAt", "updatedAt"`,
      [workspace.id, name, parentId, userId],
    );

    return rows[0];
  }

  @Patch('folders/:id')
  async updateFolder(
    @Param('id') id: string,
    @Body() body: { name?: string; parentId?: string | null },
  ): Promise<Folder> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: Folder[] = await this.coreDataSource.query(
      `UPDATE core.sales_doc_folder
          SET name = COALESCE($3, name),
              "parentId" = CASE WHEN $4::boolean THEN $5 ELSE "parentId" END,
              "updatedAt" = now()
        WHERE id = $1 AND "workspaceId" = $2
       RETURNING id, name, "parentId", "createdAt", "updatedAt"`,
      [
        id,
        workspace.id,
        body.name ?? null,
        body.parentId !== undefined,
        body.parentId ?? null,
      ],
    );

    return rows[0];
  }

  @Delete('folders/:id')
  async deleteFolder(@Param('id') id: string): Promise<{ ok: true }> {
    const { workspace } = getWorkspaceAuthContext();

    await this.coreDataSource.query(
      `DELETE FROM core.sales_doc_folder
        WHERE id = $1 AND "workspaceId" = $2`,
      [id, workspace.id],
    );

    return { ok: true };
  }

  // -------- Files --------

  @Get('files')
  async listFiles(
    @Query('folderId') folderId?: string,
  ): Promise<DocFile[]> {
    const { workspace } = getWorkspaceAuthContext();

    if (folderId === 'root' || folderId === undefined || folderId === '') {
      return this.coreDataSource.query(
        `SELECT id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "createdAt", "updatedAt"
           FROM core.sales_doc_file
          WHERE "workspaceId" = $1 AND "folderId" IS NULL
          ORDER BY name ASC`,
        [workspace.id],
      );
    }

    return this.coreDataSource.query(
      `SELECT id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "createdAt", "updatedAt"
         FROM core.sales_doc_file
        WHERE "workspaceId" = $1 AND "folderId" = $2
        ORDER BY name ASC`,
      [workspace.id, folderId],
    );
  }

  @Post('files')
  async createFile(
    @Body()
    body: {
      name: string;
      fileUrl: string;
      folderId?: string | null;
      description?: string;
      mimeType?: string;
      fileSize?: number;
    },
  ): Promise<DocFile> {
    const ctx = getWorkspaceAuthContext();
    const workspace = ctx.workspace;
    const userId = 'user' in ctx ? ctx.user.id : null;

    const rows: DocFile[] = await this.coreDataSource.query(
      `INSERT INTO core.sales_doc_file
         ("workspaceId", "folderId", name, "fileUrl", "fileSize", "mimeType", description, "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "createdAt", "updatedAt"`,
      [
        workspace.id,
        body.folderId ?? null,
        (body.name || '').trim() || 'Untitled',
        body.fileUrl,
        body.fileSize ?? 0,
        body.mimeType ?? null,
        body.description ?? null,
        userId,
      ],
    );

    return rows[0];
  }

  @Patch('files/:id')
  async updateFile(
    @Param('id') id: string,
    @Body()
    body: {
      name?: string;
      folderId?: string | null;
      description?: string;
      fileUrl?: string;
    },
  ): Promise<DocFile> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: DocFile[] = await this.coreDataSource.query(
      `UPDATE core.sales_doc_file
          SET name = COALESCE($3, name),
              "folderId" = CASE WHEN $4::boolean THEN $5 ELSE "folderId" END,
              description = COALESCE($6, description),
              "fileUrl" = COALESCE($7, "fileUrl"),
              "updatedAt" = now()
        WHERE id = $1 AND "workspaceId" = $2
       RETURNING id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "createdAt", "updatedAt"`,
      [
        id,
        workspace.id,
        body.name ?? null,
        body.folderId !== undefined,
        body.folderId ?? null,
        body.description ?? null,
        body.fileUrl ?? null,
      ],
    );

    return rows[0];
  }

  @Delete('files/:id')
  async deleteFile(@Param('id') id: string): Promise<{ ok: true }> {
    const { workspace } = getWorkspaceAuthContext();

    await this.coreDataSource.query(
      `DELETE FROM core.sales_doc_file
        WHERE id = $1 AND "workspaceId" = $2`,
      [id, workspace.id],
    );

    return { ok: true };
  }
}
