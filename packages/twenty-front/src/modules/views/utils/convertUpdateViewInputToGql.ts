import { type GraphQLView } from '@/views/types/GraphQLView';
import { isDefined } from 'twenty-shared/utils';
import { type UpdateViewInput } from '~/generated-metadata/graphql';

export const convertUpdateViewInputToGql = (
  view: Partial<GraphQLView & { __typename?: string }>,
): UpdateViewInput => {
  return {
    id: view.id,
    ...(view.name && { name: view.name }),
    ...(view.icon && { icon: view.icon }),
    ...(isDefined(view.position) && { position: view.position }),
    ...(isDefined(view.isCompact) && { isCompact: view.isCompact }),
    ...(isDefined(view.kanbanAggregateOperation) && {
      kanbanAggregateOperation: view.kanbanAggregateOperation,
    }),
    ...(isDefined(view.kanbanAggregateOperationFieldMetadataId) && {
      kanbanAggregateOperationFieldMetadataId:
        view.kanbanAggregateOperationFieldMetadataId,
    }),
    ...(isDefined(view.anyFieldFilterValue) && {
      anyFieldFilterValue: view.anyFieldFilterValue,
    }),
    // view.key is a read-only system identifier (e.g. 'INDEX'); the
    // UpdateViewInput schema rejects it. Do NOT forward it.
    ...(isDefined(view.openRecordIn) && {
      openRecordIn: view.openRecordIn,
    }),
    ...(isDefined(view.type) && { type: view.type }),
    ...(isDefined(view.calendarLayout) && {
      calendarLayout: view.calendarLayout,
    }),
    ...(isDefined(view.calendarFieldMetadataId) && {
      calendarFieldMetadataId: view.calendarFieldMetadataId,
    }),
    ...(isDefined(view.visibility) && { visibility: view.visibility }),
    ...(isDefined(view.shouldHideEmptyGroups) && {
      shouldHideEmptyGroups: view.shouldHideEmptyGroups,
    }),
    ...(view.mainGroupByFieldMetadataId !== undefined && {
      mainGroupByFieldMetadataId: view.mainGroupByFieldMetadataId,
    }),
  };
};
