import { styled } from '@linaria/react';
import { t } from '@lingui/core/macro';
import { useContext, useEffect, useState } from 'react';

import { CommandModal } from '@/command-menu-item/display/components/CommandModal';
import { CommandConfigContext } from '@/command-menu-item/contexts/CommandConfigContext';
import { contextStoreTargetedRecordsRuleComponentState } from '@/context-store/states/contextStoreTargetedRecordsRuleComponentState';
import { useAtomComponentStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomComponentStateValue';
import { useSnackBar } from '@/ui/feedback/snack-bar-manager/hooks/useSnackBar';
import { isDefined } from 'twenty-shared/utils';
import { REACT_APP_SERVER_BASE_URL } from '~/config';
import { themeCssVariables } from 'twenty-ui/theme-constants';

type JustcallCampaign = {
  id: number;
  name: string;
  status?: string;
};

const StyledForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[2]};
  margin-top: ${themeCssVariables.spacing[2]};
`;

const StyledLabel = styled.label`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.sm};
  font-weight: ${themeCssVariables.font.weight.medium};
`;

const StyledSelect = styled.select`
  background: ${themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.primary};
  font-size: ${themeCssVariables.font.size.sm};
  padding: ${themeCssVariables.spacing[2]} ${themeCssVariables.spacing[3]};
`;

const StyledNote = styled.div`
  color: ${themeCssVariables.font.color.tertiary};
  font-size: ${themeCssVariables.font.size.xs};
`;

export const SendToJustcallMultipleRecordsCommand = () => {
  const actionConfig = useContext(CommandConfigContext);
  const { enqueueSuccessSnackBar, enqueueErrorSnackBar } = useSnackBar();

  const targetedRecordsRule = useAtomComponentStateValue(
    contextStoreTargetedRecordsRuleComponentState,
  );

  const [campaigns, setCampaigns] = useState<JustcallCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const loadCampaigns = async () => {
      setIsLoadingCampaigns(true);

      try {
        const response = await fetch(
          `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/campaigns`,
          { credentials: 'include' },
        );

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const json = (await response.json()) as { data?: JustcallCampaign[] };

        if (cancelled) return;

        const list = json.data ?? [];

        setCampaigns(list);

        if (list.length > 0) {
          setSelectedCampaignId(list[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          enqueueErrorSnackBar({
            message: t`Failed to load JustCall campaigns`,
          });
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCampaigns(false);
        }
      }
    };

    loadCampaigns();

    return () => {
      cancelled = true;
    };
  }, [enqueueErrorSnackBar]);

  if (!isDefined(actionConfig)) {
    return null;
  }

  const selectedLeadIds =
    targetedRecordsRule?.mode === 'selection'
      ? targetedRecordsRule.selectedRecordIds
      : [];

  const handleSend = async () => {
    if (selectedCampaignId === null) {
      enqueueErrorSnackBar({ message: t`Pick a campaign first.` });

      return;
    }

    if (selectedLeadIds.length === 0) {
      enqueueErrorSnackBar({ message: t`No leads selected.` });

      return;
    }

    setIsSending(true);

    try {
      const response = await fetch(
        `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/send-leads`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            leadIds: selectedLeadIds,
            campaignId: selectedCampaignId,
          }),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = (await response.json()) as {
        sent?: number;
        skipped?: number;
        failed?: number;
      };

      enqueueSuccessSnackBar({
        message: t`JustCall: ${json.sent ?? 0} sent, ${json.skipped ?? 0} already-synced skipped, ${json.failed ?? 0} failed.`,
      });
    } catch (error) {
      enqueueErrorSnackBar({ message: t`Failed to push leads to JustCall.` });
    } finally {
      setIsSending(false);
    }
  };

  const subtitle = (
    <StyledForm>
      <div>
        {t`Pushing ${selectedLeadIds.length} lead(s) to the selected campaign. Leads already pushed previously will be skipped automatically.`}
      </div>
      <StyledLabel htmlFor="justcall-campaign-select">{t`Campaign`}</StyledLabel>
      <StyledSelect
        id="justcall-campaign-select"
        value={selectedCampaignId ?? ''}
        onChange={(e) => setSelectedCampaignId(Number(e.target.value))}
        disabled={isLoadingCampaigns || campaigns.length === 0}
      >
        {isLoadingCampaigns && <option>{t`Loading campaigns…`}</option>}
        {!isLoadingCampaigns && campaigns.length === 0 && (
          <option>{t`No campaigns found`}</option>
        )}
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </StyledSelect>
      <StyledNote>
        {t`Tip: filter the leads list (e.g. Country = US) and select the rows you want to send.`}
      </StyledNote>
    </StyledForm>
  );

  return (
    <CommandModal
      title={t`Send to JustCall`}
      subtitle={subtitle}
      onConfirmClick={handleSend}
      confirmButtonText={t`Send to dialer`}
      confirmButtonAccent="blue"
      isLoading={isSending}
    />
  );
};
