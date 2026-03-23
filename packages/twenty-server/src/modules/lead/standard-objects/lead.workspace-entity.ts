import {
  type ActorMetadata,
  type CurrencyMetadata,
  type EmailsMetadata,
  FieldMetadataType,
  type LinksMetadata,
  type PhonesMetadata,
} from 'twenty-shared/types';

import { BaseWorkspaceEntity } from 'src/engine/twenty-orm/base.workspace-entity';
import { type FieldTypeAndNameMetadata } from 'src/engine/workspace-manager/utils/get-ts-vector-column-expression.util';
import { type EntityRelation } from 'src/engine/workspace-manager/workspace-migration/types/entity-relation.interface';
import { type AttachmentWorkspaceEntity } from 'src/modules/attachment/standard-objects/attachment.workspace-entity';
import { type CompanyWorkspaceEntity } from 'src/modules/company/standard-objects/company.workspace-entity';
import { type FavoriteWorkspaceEntity } from 'src/modules/favorite/standard-objects/favorite.workspace-entity';
import { type NoteTargetWorkspaceEntity } from 'src/modules/note/standard-objects/note-target.workspace-entity';
import { type TaskTargetWorkspaceEntity } from 'src/modules/task/standard-objects/task-target.workspace-entity';
import { type TimelineActivityWorkspaceEntity } from 'src/modules/timeline/standard-objects/timeline-activity.workspace-entity';
import { type WorkspaceMemberWorkspaceEntity } from 'src/modules/workspace-member/standard-objects/workspace-member.workspace-entity';

const NAME_FIELD_NAME = 'name';
const EMAILS_FIELD_NAME = 'emails';
const PHONES_FIELD_NAME = 'phones';

export const SEARCH_FIELDS_FOR_LEAD: FieldTypeAndNameMetadata[] = [
  { name: NAME_FIELD_NAME, type: FieldMetadataType.TEXT },
  { name: EMAILS_FIELD_NAME, type: FieldMetadataType.EMAILS },
  { name: PHONES_FIELD_NAME, type: FieldMetadataType.PHONES },
];

export class LeadWorkspaceEntity extends BaseWorkspaceEntity {
  name: string;
  emails: EmailsMetadata;
  phones: PhonesMetadata;
  source: string;
  sourceDetail: string | null;
  needs: string | null;
  stage: string;
  priority: string;
  estimatedValue: CurrencyMetadata | null;
  nextFollowUpDate: Date | null;
  linkedinLink: LinksMetadata | null;
  enrichmentStatus: string;
  industry: string | null;
  companySize: string | null;
  companyRevenue: string | null;
  position: number;
  createdBy: ActorMetadata;
  updatedBy: ActorMetadata;
  company: EntityRelation<CompanyWorkspaceEntity> | null;
  companyId: string | null;
  assignedTo: EntityRelation<WorkspaceMemberWorkspaceEntity> | null;
  assignedToId: string | null;
  owner: EntityRelation<WorkspaceMemberWorkspaceEntity> | null;
  ownerId: string | null;
  favorites: EntityRelation<FavoriteWorkspaceEntity[]>;
  taskTargets: EntityRelation<TaskTargetWorkspaceEntity[]>;
  noteTargets: EntityRelation<NoteTargetWorkspaceEntity[]>;
  attachments: EntityRelation<AttachmentWorkspaceEntity[]>;
  timelineActivities: EntityRelation<TimelineActivityWorkspaceEntity[]>;
  searchVector: string;
}
