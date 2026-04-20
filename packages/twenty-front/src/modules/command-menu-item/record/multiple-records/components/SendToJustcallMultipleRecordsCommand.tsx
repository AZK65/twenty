import { styled } from '@linaria/react';
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

type JustcallPhone = {
  id: number | string;
  name?: string;
  number?: string;
};

type Mode = 'existing' | 'new';

const StyledForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[2]};
  margin-top: ${themeCssVariables.spacing[2]};
`;

const StyledTabs = styled.div`
  display: flex;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledTab = styled.button<{ active: boolean }>`
  background: ${({ active }) =>
    active
      ? themeCssVariables.background.tertiary
      : themeCssVariables.background.primary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  font-size: ${themeCssVariables.font.size.sm};
  padding: ${themeCssVariables.spacing[1]} ${themeCssVariables.spacing[3]};
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

const StyledInput = styled.input`
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

  const [mode, setMode] = useState<Mode>('existing');

  const [campaigns, setCampaigns] = useState<JustcallCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);

  const [phones, setPhones] = useState<JustcallPhone[]>([]);
  const [selectedPhoneId, setSelectedPhoneId] = useState<number | string | null>(null);
  const [isLoadingPhones, setIsLoadingPhones] = useState(false);

  const [newCampaignName, setNewCampaignName] = useState('');
  const [isSending, setIsSending] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoadingCampaigns(true);
      setIsLoadingPhones(true);

      try {
        const [campaignsRes, phonesRes] = await Promise.all([
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/campaigns`, {
            credentials: 'include',
          }),
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/phones`, {
            credentials: 'include',
          }),
        ]);

        const campaignsJson = (await campaignsRes.json()) as {
          data?: JustcallCampaign[];
        };
        const phonesJson = (await phonesRes.json()) as { data?: JustcallPhone[] };

        if (cancelled) return;

        const campaignList = campaignsJson.data ?? [];
        const phoneList = phonesJson.data ?? [];

        setCampaigns(campaignList);
        setPhones(phoneList);

        if (campaignList.length > 0) {
          setSelectedCampaignId(campaignList[0].id);
        } else {
          setMode('new');
        }

        if (phoneList.length > 0) {
          setSelectedPhoneId(phoneList[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          enqueueErrorSnackBar({
            message: 'Failed to load JustCall campaigns/phones',
          });
        }
      } finally {
        if (!cancelled) {
          setIsLoadingCampaigns(false);
          setIsLoadingPhones(false);
        }
      }
    };

    load();

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
    if (selectedLeadIds.length === 0) {
      enqueueErrorSnackBar({ message: 'No leads selected.' });

      return;
    }

    const body: Record<string, unknown> = { leadIds: selectedLeadIds };

    if (mode === 'existing') {
      if (selectedCampaignId === null) {
        enqueueErrorSnackBar({ message: 'Pick a campaign first.' });

        return;
      }
      body.campaignId = selectedCampaignId;
    } else {
      if (!newCampaignName.trim()) {
        enqueueErrorSnackBar({ message: 'Enter a campaign name.' });

        return;
      }
      if (selectedPhoneId === null) {
        enqueueErrorSnackBar({ message: 'Pick a phone number.' });

        return;
      }
      body.newCampaign = {
        name: newCampaignName.trim(),
        phoneNumberId: selectedPhoneId,
      };
    }

    setIsSending(true);

    try {
      const response = await fetch(
        `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/send-leads`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
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
        message: `JustCall: ${json.sent ?? 0} sent, ${json.skipped ?? 0} already-synced skipped, ${json.failed ?? 0} failed.`,
      });
    } catch (error) {
      enqueueErrorSnackBar({ message: 'Failed to push leads to JustCall.' });
    } finally {
      setIsSending(false);
    }
  };

  const subtitle = (
    <StyledForm>
      <div>
        {`Pushing ${selectedLeadIds.length} lead(s). Leads previously pushed will be skipped automatically.`}
      </div>

      <StyledTabs>
        <StyledTab
          type="button"
          active={mode === 'existing'}
          onClick={() => setMode('existing')}
        >
          Existing campaign
        </StyledTab>
        <StyledTab
          type="button"
          active={mode === 'new'}
          onClick={() => setMode('new')}
        >
          New campaign
        </StyledTab>
      </StyledTabs>

      {mode === 'existing' && (
        <>
          <StyledLabel htmlFor="justcall-campaign-select">Campaign</StyledLabel>
          <StyledSelect
            id="justcall-campaign-select"
            value={selectedCampaignId ?? ''}
            onChange={(e) => setSelectedCampaignId(Number(e.target.value))}
            disabled={isLoadingCampaigns || campaigns.length === 0}
          >
            {isLoadingCampaigns && <option>Loading campaigns…</option>}
            {!isLoadingCampaigns && campaigns.length === 0 && (
              <option>No campaigns found — switch to New campaign</option>
            )}
            {campaigns.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </StyledSelect>
        </>
      )}

      {mode === 'new' && (
        <>
          <StyledLabel htmlFor="justcall-new-name">Campaign name</StyledLabel>
          <StyledInput
            id="justcall-new-name"
            type="text"
            placeholder="US Outbound — April"
            value={newCampaignName}
            onChange={(e) => setNewCampaignName(e.target.value)}
          />
          <StyledLabel htmlFor="justcall-phone-select">
            Outbound phone number
          </StyledLabel>
          <StyledSelect
            id="justcall-phone-select"
            value={selectedPhoneId ?? ''}
            onChange={(e) => {
              const raw = e.target.value;
              const asNum = Number(raw);

              setSelectedPhoneId(isNaN(asNum) ? raw : asNum);
            }}
            disabled={isLoadingPhones || phones.length === 0}
          >
            {isLoadingPhones && <option>Loading phones…</option>}
            {!isLoadingPhones && phones.length === 0 && (
              <option>No JustCall numbers found</option>
            )}
            {phones.map((p) => (
              <option key={String(p.id)} value={p.id}>
                {p.name ? `${p.name} — ${p.number ?? ''}` : p.number ?? String(p.id)}
              </option>
            ))}
          </StyledSelect>
        </>
      )}

      <StyledNote>
        Tip: filter the leads list (e.g. Country = US) and select the rows you
        want to send.
      </StyledNote>
    </StyledForm>
  );

  return (
    <CommandModal
      title="Send to JustCall"
      subtitle={subtitle}
      onConfirmClick={handleSend}
      confirmButtonText={mode === 'new' ? 'Create & send' : 'Send to dialer'}
      confirmButtonAccent="blue"
      isLoading={isSending}
    />
  );
};
