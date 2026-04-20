import { styled } from '@linaria/react';
import { useContext, useEffect, useMemo, useState } from 'react';

import { tokenPairState } from '@/auth/states/tokenPairState';
import { CommandModal } from '@/command-menu-item/display/components/CommandModal';
import { CommandConfigContext } from '@/command-menu-item/contexts/CommandConfigContext';
import { useAtomStateValue } from '@/ui/utilities/state/jotai/hooks/useAtomStateValue';
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

const StyledDivider = styled.div`
  border-top: 1px solid ${themeCssVariables.border.color.light};
  margin: ${themeCssVariables.spacing[2]} 0 0 0;
`;

const StyledCheckboxRow = styled.label`
  align-items: center;
  color: ${themeCssVariables.font.color.primary};
  cursor: pointer;
  display: flex;
  font-size: ${themeCssVariables.font.size.sm};
  gap: ${themeCssVariables.spacing[2]};
`;

const StyledRevenueGrid = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[1]};
  max-height: 160px;
  overflow-y: auto;
  padding: ${themeCssVariables.spacing[2]};
  border: 1px solid ${themeCssVariables.border.color.light};
  border-radius: ${themeCssVariables.border.radius.sm};
`;

const StyledPreviewTable = styled.table`
  border-collapse: collapse;
  font-size: ${themeCssVariables.font.size.xs};
  width: 100%;
  th, td {
    border-bottom: 1px solid ${themeCssVariables.border.color.light};
    padding: ${themeCssVariables.spacing[1]} ${themeCssVariables.spacing[2]};
    text-align: left;
  }
  th {
    color: ${themeCssVariables.font.color.secondary};
    font-weight: ${themeCssVariables.font.weight.medium};
  }
  td {
    color: ${themeCssVariables.font.color.primary};
  }
`;

const StyledPreviewWrapper = styled.div`
  border: 1px solid ${themeCssVariables.border.color.light};
  border-radius: ${themeCssVariables.border.radius.sm};
  max-height: 360px;
  overflow-y: auto;
`;

const StyledCount = styled.div`
  color: ${themeCssVariables.font.color.primary};
  font-weight: ${themeCssVariables.font.weight.medium};
  font-size: ${themeCssVariables.font.size.sm};
`;

export const SendToJustcallMultipleRecordsCommand = () => {
  const actionConfig = useContext(CommandConfigContext);
  const { enqueueSuccessSnackBar, enqueueErrorSnackBar } = useSnackBar();

  const tokenPair = useAtomStateValue(tokenPairState);
  const token = tokenPair?.accessOrWorkspaceAgnosticToken?.token;
  const authHeader = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {};

    if (token) h.Authorization = `Bearer ${token}`;

    return h;
  }, [token]);

  const [mode, setMode] = useState<Mode>('existing');

  const [campaigns, setCampaigns] = useState<JustcallCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<number | null>(null);
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);

  const [phones, setPhones] = useState<JustcallPhone[]>([]);
  const [selectedPhoneId, setSelectedPhoneId] = useState<number | string | null>(null);
  const [isLoadingPhones, setIsLoadingPhones] = useState(false);

  const [newCampaignName, setNewCampaignName] = useState('');
  const [isSending, setIsSending] = useState(false);

  const [revenueValues, setRevenueValues] = useState<string[]>([]);
  const [selectedRevenues, setSelectedRevenues] = useState<Set<string>>(new Set());
  const [usOnly, setUsOnly] = useState(true);
  const [maxAgeDays, setMaxAgeDays] = useState<string>('');
  const [cooldownDays, setCooldownDays] = useState<string>('30');

  const [matchingCount, setMatchingCount] = useState<number | null>(null);
  const [sample, setSample] = useState<
    Array<{ id: string; name: string; phone: string; companyRevenue: string | null; createdAt: string }>
  >([]);
  const [isCounting, setIsCounting] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoadingCampaigns(true);
      setIsLoadingPhones(true);

      try {
        const [campaignsRes, phonesRes, revenuesRes] = await Promise.all([
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/campaigns`, {
            credentials: 'include',
            headers: { ...authHeader },
          }),
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/phones`, {
            credentials: 'include',
            headers: { ...authHeader },
          }),
          fetch(
            `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/revenue-values`,
            { credentials: 'include', headers: { ...authHeader } },
          ),
        ]);

        const campaignsJson = (await campaignsRes.json()) as {
          data?: JustcallCampaign[];
        };
        const phonesJson = (await phonesRes.json()) as { data?: JustcallPhone[] };
        const revenuesJson = (await revenuesRes.json()) as { data?: string[] };

        if (cancelled) return;

        const campaignList = campaignsJson.data ?? [];
        const phoneList = phonesJson.data ?? [];
        const revenueList = revenuesJson.data ?? [];

        setCampaigns(campaignList);
        setPhones(phoneList);
        setRevenueValues(revenueList);

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

  // Live preview: count + sample rows, updates whenever filters change.
  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      setIsCounting(true);

      try {
        const response = await fetch(
          `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/preview`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              filters: {
                usOnly,
                companyRevenues: Array.from(selectedRevenues),
                maxAgeDays: maxAgeDays ? Number(maxAgeDays) : undefined,
                cooldownDays: cooldownDays ? Number(cooldownDays) : undefined,
              },
            }),
          },
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as {
          count?: number;
          sample?: Array<{
            id: string;
            name: string;
            phone: string;
            companyRevenue: string | null;
            createdAt: string;
          }>;
        };

        if (!cancelled) {
          setMatchingCount(json.count ?? 0);
          setSample(json.sample ?? []);
        }
      } catch {
        if (!cancelled) {
          setMatchingCount(null);
          setSample([]);
        }
      } finally {
        if (!cancelled) setIsCounting(false);
      }
    };

    loadPreview();

    return () => {
      cancelled = true;
    };
  }, [usOnly, selectedRevenues, maxAgeDays, cooldownDays, authHeader]);

  const handleSend = async () => {
    if (!matchingCount || matchingCount === 0) {
      enqueueErrorSnackBar({
        message: 'No leads match the filters. Adjust filters and try again.',
      });

      return;
    }

    const body: Record<string, unknown> = { matchAllFilters: true };

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

    body.filters = {
      usOnly,
      companyRevenues: Array.from(selectedRevenues),
      maxAgeDays: maxAgeDays ? Number(maxAgeDays) : undefined,
      cooldownDays: cooldownDays ? Number(cooldownDays) : undefined,
    };

    setIsSending(true);

    try {
      const response = await fetch(
        `${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/send-leads`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify(body),
        },
      );

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const json = (await response.json()) as {
        sent?: number;
        skipped?: number;
        filtered?: number;
        failed?: number;
      };

      enqueueSuccessSnackBar({
        message: `JustCall: ${json.sent ?? 0} sent, ${json.skipped ?? 0} already synced, ${json.filtered ?? 0} filtered out, ${json.failed ?? 0} failed.`,
      });
    } catch (error) {
      enqueueErrorSnackBar({ message: 'Failed to push leads to JustCall.' });
    } finally {
      setIsSending(false);
    }
  };

  const subtitle = (
    <StyledForm>
      <StyledCount>
        {isCounting
          ? 'Counting matching leads…'
          : matchingCount === null
            ? 'Apply filters below to preview matches.'
            : `${matchingCount} lead(s) match your filters.`}
      </StyledCount>
      <StyledNote>
        Leads already pushed to JustCall are skipped automatically. Capped at 1000 per send.
      </StyledNote>

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

      <StyledDivider />

      <StyledLabel>Filters</StyledLabel>

      <StyledCheckboxRow>
        <input
          type="checkbox"
          checked={usOnly}
          onChange={(e) => setUsOnly(e.target.checked)}
        />
        US phone numbers only (normalizes to +1)
      </StyledCheckboxRow>

      <StyledLabel>Only leads added to the CRM in the last N days (leave empty for no limit)</StyledLabel>
      <StyledInput
        type="number"
        inputMode="numeric"
        placeholder="e.g. 30"
        min={1}
        value={maxAgeDays}
        onChange={(e) => setMaxAgeDays(e.target.value)}
      />

      <StyledLabel>Skip leads contacted in the last N days (cooldown — 0 or empty to disable)</StyledLabel>
      <StyledInput
        type="number"
        inputMode="numeric"
        placeholder="e.g. 30"
        min={0}
        value={cooldownDays}
        onChange={(e) => setCooldownDays(e.target.value)}
      />

      {revenueValues.length > 0 && (
        <>
          <StyledLabel>Company revenue (leave empty to include all)</StyledLabel>
          <StyledRevenueGrid>
            {revenueValues.map((v) => (
              <StyledCheckboxRow key={v}>
                <input
                  type="checkbox"
                  checked={selectedRevenues.has(v)}
                  onChange={(e) => {
                    const next = new Set(selectedRevenues);

                    if (e.target.checked) next.add(v);
                    else next.delete(v);
                    setSelectedRevenues(next);
                  }}
                />
                {v}
              </StyledCheckboxRow>
            ))}
          </StyledRevenueGrid>
        </>
      )}

      {sample.length > 0 && (
        <>
          <StyledLabel>Preview ({sample.length})</StyledLabel>
          <StyledPreviewWrapper>
            <StyledPreviewTable>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Phone</th>
                  <th>Revenue</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.phone}</td>
                    <td>{row.companyRevenue ?? '—'}</td>
                    <td>
                      {row.createdAt
                        ? new Date(row.createdAt).toLocaleDateString()
                        : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </StyledPreviewTable>
          </StyledPreviewWrapper>
        </>
      )}
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
