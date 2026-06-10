import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddSalesDealTable1774200000000 implements MigrationInterface {
  name = 'AddSalesDealTable1774200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "core"."sales_deal" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "workspaceId" uuid NOT NULL,
        "sourceOpportunityId" uuid NOT NULL,
        "position" double precision NOT NULL DEFAULT 0,
        "name" text NOT NULL DEFAULT '',
        "brand" text NOT NULL DEFAULT '',
        "companyRevenue" text NOT NULL DEFAULT '',
        "appticsCrm" text NOT NULL DEFAULT '',
        "stage" text NOT NULL DEFAULT '',
        "leadSource" text NOT NULL DEFAULT '',
        "salesRep" text NOT NULL DEFAULT '',
        "mrr" numeric,
        "jakePay" numeric,
        "finityPay" numeric,
        "notes" text NOT NULL DEFAULT '',
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_sales_deal" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_sales_deal_workspace_opportunity" UNIQUE ("workspaceId", "sourceOpportunityId")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_sales_deal_workspace"
        ON "core"."sales_deal" ("workspaceId")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "core"."sales_deal"`);
  }
}
