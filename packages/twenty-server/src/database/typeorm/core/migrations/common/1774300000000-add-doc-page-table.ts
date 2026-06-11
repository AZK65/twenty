import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddDocPageTable1774300000000 implements MigrationInterface {
  name = 'AddDocPageTable1774300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "core"."doc_page" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workspaceId" uuid NOT NULL,
        "slug" text NOT NULL,
        "title" text NOT NULL DEFAULT '',
        "content" text NOT NULL DEFAULT '',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_doc_page" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_doc_page_workspace_slug" UNIQUE ("workspaceId","slug")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "core"."doc_page"`);
  }
}
