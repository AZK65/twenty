import { type FlatViewField } from 'src/engine/metadata-modules/flat-view-field/types/flat-view-field.type';
import {
  createStandardViewFieldFlatMetadata,
  type CreateStandardViewFieldArgs,
} from 'src/engine/workspace-manager/twenty-standard-application/utils/view-field/create-standard-view-field-flat-metadata.util';

export const computeStandardLeadViewFields = (
  args: Omit<CreateStandardViewFieldArgs<'lead'>, 'context'>,
): Record<string, FlatViewField> => {
  return {
    // allLeads view fields
    allLeadsName: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'name',
        fieldName: 'name',
        position: 0,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsEmails: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'emails',
        fieldName: 'emails',
        position: 1,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsCompany: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'company',
        fieldName: 'company',
        position: 2,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsStage: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'stage',
        fieldName: 'stage',
        position: 3,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsSource: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'source',
        fieldName: 'source',
        position: 4,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsPriority: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'priority',
        fieldName: 'priority',
        position: 5,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsEstimatedValue: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'estimatedValue',
        fieldName: 'estimatedValue',
        position: 6,
        isVisible: true,
        size: 150,
      },
    }),
    allLeadsAssignedTo: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'allLeads',
        viewFieldName: 'assignedTo',
        fieldName: 'assignedTo',
        position: 7,
        isVisible: true,
        size: 150,
      },
    }),

    // byStage view fields
    byStageName: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'name',
        fieldName: 'name',
        position: 0,
        isVisible: true,
        size: 150,
      },
    }),
    byStageEmails: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'emails',
        fieldName: 'emails',
        position: 1,
        isVisible: true,
        size: 150,
      },
    }),
    byStageCompany: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'company',
        fieldName: 'company',
        position: 2,
        isVisible: true,
        size: 150,
      },
    }),
    byStageSource: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'source',
        fieldName: 'source',
        position: 3,
        isVisible: true,
        size: 150,
      },
    }),
    byStagePriority: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'priority',
        fieldName: 'priority',
        position: 4,
        isVisible: true,
        size: 150,
      },
    }),
    byStageEstimatedValue: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'estimatedValue',
        fieldName: 'estimatedValue',
        position: 5,
        isVisible: true,
        size: 150,
      },
    }),
    byStageAssignedTo: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'byStage',
        viewFieldName: 'assignedTo',
        fieldName: 'assignedTo',
        position: 6,
        isVisible: true,
        size: 150,
      },
    }),

    // leadRecordPageFields view fields
    leadRecordPageFieldsEstimatedValue: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'estimatedValue',
        fieldName: 'estimatedValue',
        position: 0,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsNextFollowUpDate: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'nextFollowUpDate',
        fieldName: 'nextFollowUpDate',
        position: 1,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsStage: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'stage',
        fieldName: 'stage',
        position: 2,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsSource: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'source',
        fieldName: 'source',
        position: 3,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsSourceDetail: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'sourceDetail',
        fieldName: 'sourceDetail',
        position: 4,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsPriority: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'priority',
        fieldName: 'priority',
        position: 5,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsNeeds: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'needs',
        fieldName: 'needs',
        position: 6,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsLinkedinLink: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'linkedinLink',
        fieldName: 'linkedinLink',
        position: 7,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsEnrichmentStatus: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'enrichmentStatus',
        fieldName: 'enrichmentStatus',
        position: 8,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsIndustry: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'industry',
        fieldName: 'industry',
        position: 9,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsCompanySize: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'companySize',
        fieldName: 'companySize',
        position: 10,
        isVisible: true,
        size: 150,
      },
    }),
    leadRecordPageFieldsCompanyRevenue: createStandardViewFieldFlatMetadata({
      ...args,
      objectName: 'lead',
      context: {
        viewName: 'leadRecordPageFields',
        viewFieldName: 'companyRevenue',
        fieldName: 'companyRevenue',
        position: 11,
        isVisible: true,
        size: 150,
      },
    }),
  };
};
