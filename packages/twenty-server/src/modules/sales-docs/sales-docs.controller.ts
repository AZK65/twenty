import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { InjectDataSource } from '@nestjs/typeorm';

import { type Request, type Response } from 'express';
import { extname } from 'path';
import { Readable } from 'stream';
import { DataSource } from 'typeorm';
import { v4 as uuidv4 } from 'uuid';

import { getWorkspaceAuthContext } from 'src/engine/core-modules/auth/storage/workspace-auth-context.storage';
import { FileStorageDriverFactory } from 'src/engine/core-modules/file-storage/file-storage-driver.factory';
import { JwtAuthGuard } from 'src/engine/guards/jwt-auth.guard';
import { NoPermissionGuard } from 'src/engine/guards/no-permission.guard';
import { WorkspaceAuthGuard } from 'src/engine/guards/workspace-auth.guard';

// Multer file type — keeps us free of @types/multer.
type UploadedMulterFile = {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
};

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
  storagePath: string | null;
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
    private readonly fileStorageDriverFactory: FileStorageDriverFactory,
  ) {}

  private storagePathFor(workspaceId: string, fileId: string, ext: string) {
    return `${workspaceId}/sales-docs/${fileId}${ext}`;
  }

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
        `SELECT id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"
           FROM core.sales_doc_file
          WHERE "workspaceId" = $1 AND "folderId" IS NULL
          ORDER BY name ASC`,
        [workspace.id],
      );
    }

    return this.coreDataSource.query(
      `SELECT id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"
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
       RETURNING id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"`,
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
       RETURNING id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"`,
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

    const rows: { storagePath: string | null }[] =
      await this.coreDataSource.query(
        `SELECT "storagePath" FROM core.sales_doc_file
          WHERE id = $1 AND "workspaceId" = $2`,
        [id, workspace.id],
      );

    if (rows[0]?.storagePath) {
      try {
        const driver = this.fileStorageDriverFactory.getCurrentDriver();
        const path = rows[0].storagePath;
        const slash = path.lastIndexOf('/');
        const folderPath = slash >= 0 ? path.slice(0, slash) : '';
        const filename = slash >= 0 ? path.slice(slash + 1) : path;

        await driver.delete({ folderPath, filename });
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn('sales-docs: failed to delete blob', err);
      }
    }

    await this.coreDataSource.query(
      `DELETE FROM core.sales_doc_file
        WHERE id = $1 AND "workspaceId" = $2`,
      [id, workspace.id],
    );

    return { ok: true };
  }

  // -------- Upload + download --------

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadFile(
    @UploadedFile() file: UploadedMulterFile,
    @Req() req: Request,
  ): Promise<DocFile> {
    const ctx = getWorkspaceAuthContext();
    const workspace = ctx.workspace;
    const userId = 'user' in ctx ? ctx.user.id : null;

    if (!file) {
      throw new Error('No file uploaded');
    }

    const rawFolderId = (req.body as { folderId?: string } | undefined)
      ?.folderId;
    const folderId =
      typeof rawFolderId === 'string' && rawFolderId !== ''
        ? rawFolderId
        : null;

    const rawName = (req.body as { name?: string } | undefined)?.name;
    const customName =
      typeof rawName === 'string' && rawName.trim() !== ''
        ? rawName.trim()
        : file.originalname;

    const fileId = uuidv4();
    const ext = extname(file.originalname) || '';
    const storagePath = this.storagePathFor(workspace.id, fileId, ext);

    const driver = this.fileStorageDriverFactory.getCurrentDriver();

    await driver.writeFile({
      filePath: storagePath,
      sourceFile: file.buffer,
      mimeType: file.mimetype,
    });

    const rows: DocFile[] = await this.coreDataSource.query(
      `INSERT INTO core.sales_doc_file
         (id, "workspaceId", "folderId", name, "fileUrl", "fileSize", "mimeType", "storagePath", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"`,
      [
        fileId,
        workspace.id,
        folderId,
        customName,
        '',
        file.size,
        file.mimetype,
        storagePath,
        userId,
      ],
    );

    return rows[0];
  }

  @Get('files/:id/download')
  async downloadFile(
    @Param('id') id: string,
    @Res() res: Response,
  ): Promise<void> {
    const { workspace } = getWorkspaceAuthContext();

    const rows: DocFile[] = await this.coreDataSource.query(
      `SELECT id, "folderId", name, "fileUrl", "fileSize", "mimeType", description, "storagePath", "createdAt", "updatedAt"
         FROM core.sales_doc_file
        WHERE id = $1 AND "workspaceId" = $2`,
      [id, workspace.id],
    );

    const file = rows[0];

    if (!file) {
      res.status(404).send('Not found');

      return;
    }

    if (!file.storagePath) {
      res.redirect(file.fileUrl);

      return;
    }

    const driver = this.fileStorageDriverFactory.getCurrentDriver();
    const stream: Readable = await driver.readFile({
      filePath: file.storagePath,
    });

    res.setHeader(
      'Content-Type',
      file.mimeType ?? 'application/octet-stream',
    );
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${encodeURIComponent(file.name)}"`,
    );

    stream.on('error', (err) => {
      // eslint-disable-next-line no-console
      console.error('sales-docs download stream error', err);
      if (!res.headersSent) res.status(500).send('Stream error');
    });
    stream.pipe(res);
  }
}
