import { styled } from '@linaria/react';
import { useEffect, useRef } from 'react';

import { contextStoreCurrentViewIdComponentState } from '@/context-store/states/contextStoreCurrentViewIdComponentState';
import { Dropdown } from '@/ui/layout/dropdown/components/Dropdown';
import { DropdownContent } from '@/ui/layout/dropdown/components/DropdownContent';
import { DropdownMenuItemsContainer } from '@/ui/layout/dropdown/components/DropdownMenuItemsContainer';
import { useCloseDropdown } from '@/ui/layout/dropdown/hooks/useCloseDropdown';
import { useOpenDropdown } from '@/ui/layout/dropdown/hooks/useOpenDropdown';
import { useAtomComponentStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomComponentStateValue';
import { useSetAtomComponentState } from '@/ui/utilities/state/jotai/hooks/useSetAtomComponentState';
import { UPDATE_VIEW_BUTTON_DROPDOWN_ID } from '@/views/constants/UpdateViewButtonDropdownId';
import { useHasFiltersInQueryParams } from '@/views/hooks/internal/useHasFiltersInQueryParams';
import { useAreViewFilterGroupsDifferentFromRecordFilterGroups } from '@/views/hooks/useAreViewFilterGroupsDifferentFromRecordFilterGroups';
import { useAreViewFiltersDifferentFromRecordFilters } from '@/views/hooks/useAreViewFiltersDifferentFromRecordFilters';
import { useAreViewSortsDifferentFromRecordSorts } from '@/views/hooks/useAreViewSortsDifferentFromRecordSorts';
import { useCanPersistViewChanges } from '@/views/hooks/useCanPersistViewChanges';
import { useGetCurrentViewOnly } from '@/views/hooks/useGetCurrentViewOnly';
import { useIsViewAnyFieldFilterDifferentFromCurrentAnyFieldFilter } from '@/views/hooks/useIsViewAnyFieldFilterDifferentFromCurrentAnyFieldFilter';
import { useSaveCurrentViewFiltersAndSorts } from '@/views/hooks/useSaveCurrentViewFiltersAndSorts';
import { VIEW_PICKER_DROPDOWN_ID } from '@/views/view-picker/constants/ViewPickerDropdownId';
import { useViewPickerMode } from '@/views/view-picker/hooks/useViewPickerMode';
import { viewPickerReferenceViewIdComponentState } from '@/views/view-picker/states/viewPickerReferenceViewIdComponentState';
import { t } from '@lingui/core/macro';
import { IconChevronDown, IconPlus } from 'twenty-ui/display';
import { Button, ButtonGroup, IconButton } from 'twenty-ui/input';
import { MenuItem } from 'twenty-ui/navigation';
import { themeCssVariables } from 'twenty-ui/theme-constants';

const StyledContainer = styled.div`
  border-radius: ${themeCssVariables.border.radius.md};
  display: inline-flex;
  margin-right: ${themeCssVariables.spacing[2]};
  position: relative;
`;

export const UpdateViewButtonGroup = () => {
  const { saveCurrentViewFilterAndSorts } = useSaveCurrentViewFiltersAndSorts();
  const { canPersistChanges } = useCanPersistViewChanges();

  const { setViewPickerMode } = useViewPickerMode();

  const contextStoreCurrentViewId = useAtomComponentStateValue(
    contextStoreCurrentViewIdComponentState,
  );

  const { closeDropdown: closeUpdateViewButtonDropdown } = useCloseDropdown();
  const { openDropdown: openViewPickerDropdown } = useOpenDropdown();
  const { currentView } = useGetCurrentViewOnly();

  const setViewPickerReferenceViewId = useSetAtomComponentState(
    viewPickerReferenceViewIdComponentState,
  );

  const openViewPickerInCreateMode = () => {
    if (!contextStoreCurrentViewId) {
      return;
    }

    openViewPickerDropdown({
      dropdownComponentInstanceIdFromProps: VIEW_PICKER_DROPDOWN_ID,
    });
    setViewPickerReferenceViewId(contextStoreCurrentViewId);
    setViewPickerMode('create-from-current');

    closeUpdateViewButtonDropdown(UPDATE_VIEW_BUTTON_DROPDOWN_ID);
  };

  const handleCreateViewClick = () => {
    openViewPickerInCreateMode();
  };

  const handleSaveAsNewViewClick = () => {
    openViewPickerInCreateMode();
  };

  const handleUpdateViewClick = async () => {
    if (!canPersistChanges) return;
    await saveCurrentViewFilterAndSorts();
  };

  const { hasFiltersQueryParams } = useHasFiltersInQueryParams();

  const { viewFilterGroupsAreDifferentFromRecordFilterGroups } =
    useAreViewFilterGroupsDifferentFromRecordFilterGroups();

  const { viewFiltersAreDifferentFromRecordFilters } =
    useAreViewFiltersDifferentFromRecordFilters();

  const { viewSortsAreDifferentFromRecordSorts } =
    useAreViewSortsDifferentFromRecordSorts();

  const { viewAnyFieldFilterDifferentFromCurrentAnyFieldFilter } =
    useIsViewAnyFieldFilterDifferentFromCurrentAnyFieldFilter();

  const isDirty =
    (viewFiltersAreDifferentFromRecordFilters ||
      viewSortsAreDifferentFromRecordSorts ||
      viewFilterGroupsAreDifferentFromRecordFilterGroups ||
      viewAnyFieldFilterDifferentFromCurrentAnyFieldFilter) &&
    !hasFiltersQueryParams;

  // Auto-save: whenever the view is dirty and the user has permission,
  // persist after a debounce. isSavingRef prevents stacking concurrent saves
  // while Apollo's cache catches up — otherwise the same viewSort row gets
  // inserted twice and the second insert 500s on a unique constraint.
  const autoSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isSavingRef = useRef(false);

  useEffect(() => {
    if (!isDirty || !canPersistChanges || isSavingRef.current) {
      return;
    }

    if (autoSaveTimerRef.current) {
      clearTimeout(autoSaveTimerRef.current);
    }

    autoSaveTimerRef.current = setTimeout(async () => {
      if (isSavingRef.current) return;
      isSavingRef.current = true;
      try {
        await saveCurrentViewFilterAndSorts();
      } catch {
        // swallow; the manual Update View button is still available
      } finally {
        isSavingRef.current = false;
      }
    }, 800);

    return () => {
      if (autoSaveTimerRef.current) {
        clearTimeout(autoSaveTimerRef.current);
      }
    };
  }, [isDirty, canPersistChanges, saveCurrentViewFilterAndSorts]);

  if (!isDirty) {
    return <></>;
  }

  return (
    <StyledContainer>
      {currentView?.key !== 'INDEX' ? (
        <ButtonGroup size="small" accent="blue">
          <Button
            title={t`Update view`}
            onClick={handleUpdateViewClick}
            disabled={!canPersistChanges}
          />
          <Dropdown
            dropdownId={UPDATE_VIEW_BUTTON_DROPDOWN_ID}
            clickableComponent={
              <IconButton
                size="small"
                accent="blue"
                Icon={IconChevronDown}
                position="right"
              />
            }
            dropdownComponents={
              <DropdownContent>
                <DropdownMenuItemsContainer>
                  <MenuItem
                    onClick={handleCreateViewClick}
                    LeftIcon={IconPlus}
                    text={t`Create view`}
                  />
                </DropdownMenuItemsContainer>
              </DropdownContent>
            }
          />
        </ButtonGroup>
      ) : (
        <Button
          title={t`Save as new view`}
          onClick={handleSaveAsNewViewClick}
          accent="blue"
          size="small"
          variant="secondary"
        />
      )}
    </StyledContainer>
  );
};
