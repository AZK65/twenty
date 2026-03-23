import { type FlatViewGroup } from 'src/engine/metadata-modules/flat-view-group/types/flat-view-group.type';
import {
  createStandardViewGroupFlatMetadata,
  type CreateStandardViewGroupArgs,
} from 'src/engine/workspace-manager/twenty-standard-application/utils/view-group/create-standard-view-group-flat-metadata.util';

export const computeStandardLeadViewGroups = (
  args: Omit<CreateStandardViewGroupArgs<'lead'>, 'context'>,
): Record<string, FlatViewGroup> => {
  return {
    byStageNew: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'new',
        isVisible: true,
        fieldValue: 'NEW',
        position: 0,
      },
    }),
    byStageContacted: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'contacted',
        isVisible: true,
        fieldValue: 'CONTACTED',
        position: 1,
      },
    }),
    byStageQualified: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'qualified',
        isVisible: true,
        fieldValue: 'QUALIFIED',
        position: 2,
      },
    }),
    byStagePreCall: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'preCall',
        isVisible: true,
        fieldValue: 'PRE_CALL',
        position: 3,
      },
    }),
    byStageMeetingScheduled: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'meetingScheduled',
        isVisible: true,
        fieldValue: 'MEETING_SCHEDULED',
        position: 4,
      },
    }),
    byStageProposal: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'proposal',
        isVisible: true,
        fieldValue: 'PROPOSAL',
        position: 5,
      },
    }),
    byStageNegotiation: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'negotiation',
        isVisible: true,
        fieldValue: 'NEGOTIATION',
        position: 6,
      },
    }),
    byStageWon: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'won',
        isVisible: true,
        fieldValue: 'WON',
        position: 7,
      },
    }),
    byStageLost: createStandardViewGroupFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewGroupName: 'lost',
        isVisible: true,
        fieldValue: 'LOST',
        position: 8,
      },
    }),
  };
};
