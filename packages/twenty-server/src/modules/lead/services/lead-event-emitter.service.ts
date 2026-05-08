import { Injectable, Logger } from '@nestjs/common';

import {
  ObjectRecordCreateEvent,
  ObjectRecordDeleteEvent,
  ObjectRecordRestoreEvent,
  ObjectRecordUpdateEvent,
} from 'twenty-shared/database-events';

import { DatabaseEventAction } from 'src/engine/api/graphql/graphql-query-runner/enums/database-event-action';
import { WorkspaceCacheService } from 'src/engine/workspace-cache/services/workspace-cache.service';
import { WorkspaceEventEmitter } from 'src/engine/workspace-event-emitter/workspace-event-emitter';

// Emits database events for records inserted/updated via raw SQL,
// so that the real-time subscription system picks them up.

@Injectable()
export class LeadEventEmitterService {
  private readonly logger = new Logger(LeadEventEmitterService.name);

  constructor(
    private readonly workspaceEventEmitter: WorkspaceEventEmitter,
    private readonly workspaceCacheService: WorkspaceCacheService,
  ) {}

  async emitLeadCreated(
    leadId: string,
    leadData: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    await this.emitCreated('lead', leadId, leadData, workspaceId);
  }

  async emitCreated(
    objectNameSingular: string,
    recordId: string,
    recordData: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    try {
      const objectMetadata = await this.findObjectMetadata(
        workspaceId,
        objectNameSingular,
      );

      if (!objectMetadata) {
        this.logger.warn(
          `${objectNameSingular} object metadata not found in cache`,
        );

        return;
      }

      const event = new ObjectRecordCreateEvent();

      event.recordId = recordId;
      event.properties = { after: { id: recordId, ...recordData } };

      this.workspaceEventEmitter.emitDatabaseBatchEvent({
        objectMetadataNameSingular: objectNameSingular,
        action: DatabaseEventAction.CREATED,
        events: [event],
        objectMetadata: objectMetadata as never,
        workspaceId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit CREATED event for ${objectNameSingular}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async emitUpdated(
    objectNameSingular: string,
    recordId: string,
    before: Record<string, unknown>,
    after: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    try {
      const objectMetadata = await this.findObjectMetadata(
        workspaceId,
        objectNameSingular,
      );

      if (!objectMetadata) return;

      const event = new ObjectRecordUpdateEvent();

      event.recordId = recordId;
      event.properties = {
        before: { id: recordId, ...before },
        after: { id: recordId, ...after },
        diff: after,
        updatedFields: Object.keys(after),
      };

      this.workspaceEventEmitter.emitDatabaseBatchEvent({
        objectMetadataNameSingular: objectNameSingular,
        action: DatabaseEventAction.UPDATED,
        events: [event],
        objectMetadata: objectMetadata as never,
        workspaceId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit UPDATED event for ${objectNameSingular}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async emitDeleted(
    objectNameSingular: string,
    recordId: string,
    recordData: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    try {
      const objectMetadata = await this.findObjectMetadata(
        workspaceId,
        objectNameSingular,
      );

      if (!objectMetadata) return;

      const event = new ObjectRecordDeleteEvent();

      event.recordId = recordId;
      event.properties = {
        before: { id: recordId, ...recordData, deletedAt: null } as never,
        after: {
          id: recordId,
          ...recordData,
          deletedAt: new Date().toISOString(),
        } as never,
        updatedFields: ['deletedAt'],
        diff: { deletedAt: { before: null, after: new Date().toISOString() } },
      };

      this.workspaceEventEmitter.emitDatabaseBatchEvent({
        objectMetadataNameSingular: objectNameSingular,
        action: DatabaseEventAction.DELETED,
        events: [event],
        objectMetadata: objectMetadata as never,
        workspaceId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit DELETED event for ${objectNameSingular}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async emitRestored(
    objectNameSingular: string,
    recordId: string,
    recordData: Record<string, unknown>,
    workspaceId: string,
  ): Promise<void> {
    try {
      const objectMetadata = await this.findObjectMetadata(
        workspaceId,
        objectNameSingular,
      );

      if (!objectMetadata) return;

      const event = new ObjectRecordRestoreEvent();

      event.recordId = recordId;
      event.properties = {
        before: {
          id: recordId,
          ...recordData,
          deletedAt: new Date().toISOString(),
        } as never,
        after: { id: recordId, ...recordData, deletedAt: null } as never,
        updatedFields: ['deletedAt'],
        diff: { deletedAt: { before: new Date().toISOString(), after: null } },
      };

      this.workspaceEventEmitter.emitDatabaseBatchEvent({
        objectMetadataNameSingular: objectNameSingular,
        action: DatabaseEventAction.RESTORED,
        events: [event],
        objectMetadata: objectMetadata as never,
        workspaceId,
      });
    } catch (error) {
      this.logger.warn(
        `Failed to emit RESTORED event for ${objectNameSingular}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async findObjectMetadata(workspaceId: string, nameSingular: string) {
    const { flatObjectMetadataMaps } =
      await this.workspaceCacheService.getOrRecompute(workspaceId, [
        'flatObjectMetadataMaps',
      ]);

    return Object.values(flatObjectMetadataMaps.byUniversalIdentifier).find(
      (meta) =>
        meta && 'nameSingular' in meta && meta.nameSingular === nameSingular,
    );
  }
}
