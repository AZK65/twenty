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

type PlusvibeCampaign = { id: string; name: string; status?: string };

type SampleRow = {
  id: string;
  name: string;
  email: string;
  companyRevenue: string | null;
  createdAt: string;
};

const StyledForm = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[2]};
  margin-top: ${themeCssVariables.spacing[2]};
  width: 100%;
  text-align: left;
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
  min-width: 100%;
  table-layout: auto;
  white-space: nowrap;
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
  overflow: auto;
`;

const StyledCount = styled.div`
  color: ${themeCssVariables.font.color.primary};
  font-weight: ${themeCssVariables.font.weight.medium};
  font-size: ${themeCssVariables.font.size.sm};
`;

export const SendToPlusvibeMultipleRecordsCommand = () => {
  const actionConfig = useContext(CommandConfigContext);
  const { enqueueSuccessSnackBar, enqueueErrorSnackBar } = useSnackBar();

  const tokenPair = useAtomStateValue(tokenPairState);
  const token = tokenPair?.accessOrWorkspaceAgnosticToken?.token;
  const authHeader = useMemo<Record<string, string>>(() => {
    const h: Record<string, string> = {};

    if (token) h.Authorization = `Bearer ${token}`;

    return h;
  }, [token]);

  const [campaigns, setCampaigns] = useState<PlusvibeCampaign[]>([]);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(
    null,
  );
  const [isLoadingCampaigns, setIsLoadingCampaigns] = useState(false);

  const [revenueValues, setRevenueValues] = useState<string[]>([]);
  const [selectedRevenues, setSelectedRevenues] = useState<Set<string>>(
    new Set(),
  );
  const [minAgeDays, setMinAgeDays] = useState<string>('30');
  const [maxAgeDays, setMaxAgeDays] = useState<string>('90');
  const [countryFilter, setCountryFilter] = useState<'all' | 'us' | 'non_us'>(
    'all',
  );

  const [matchingCount, setMatchingCount] = useState<number | null>(null);
  const [sample, setSample] = useState<SampleRow[]>([]);
  const [isCounting, setIsCounting] = useState(false);
  const [isSending, setIsSending] = useState(false);

  // Load campaigns + revenue values once
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      setIsLoadingCampaigns(true);

      try {
        const [campaignsRes, revenuesRes] = await Promise.all([
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/plusvibe/campaigns`, {
            credentials: 'include',
            headers: { ...authHeader },
          }),
          fetch(`${REACT_APP_SERVER_BASE_URL}/rest/integrations/justcall/revenue-values`, {
            credentials: 'include',
            headers: { ...authHeader },
          }),
        ]);

        const campaignsJson = (await campaignsRes.json()) as {
          data?: PlusvibeCampaign[];
        };
        const revenuesJson = (await revenuesRes.json()) as { data?: string[] };

        if (cancelled) return;

        const campaignList = campaignsJson.data ?? [];

        setCampaigns(campaignList);
        setRevenueValues(revenuesJson.data ?? []);

        if (campaignList.length > 0) {
          setSelectedCampaignId(campaignList[0].id);
        }
      } catch (error) {
        if (!cancelled) {
          enqueueErrorSnackBar({
            message: 'Failed to load PlusVibe campaigns',
          });
        }
      } finally {
        if (!cancelled) setIsLoadingCampaigns(false);
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [enqueueErrorSnackBar, authHeader]);

  // Live preview
  useEffect(() => {
    let cancelled = false;

    const loadPreview = async () => {
      setIsCounting(true);

      try {
        const response = await fetch(
          `${REACT_APP_SERVER_BASE_URL}/rest/integrations/plusvibe/preview`,
          {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json', ...authHeader },
            body: JSON.stringify({
              filters: {
                companyRevenues: Array.from(selectedRevenues),
                minAgeDays: minAgeDays ? Number(minAgeDays) : undefined,
                maxAgeDays: maxAgeDays ? Number(maxAgeDays) : undefined,
                countryFilter,
              },
            }),
          },
        );

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const json = (await response.json()) as {
          count?: number;
          sample?: SampleRow[];
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
  }, [selectedRevenues, minAgeDays, maxAgeDays, countryFilter, authHeader]);

  if (!isDefined(actionConfig)) {
    return null;
  }

  const handleSend = async () => {
    if (!selectedCampaignId) {
      enqueueErrorSnackBar({ message: 'Pick a campaign first.' });

      return;
    }

    if (!matchingCount || matchingCount === 0) {
      enqueueErrorSnackBar({
        message: 'No leads match the filters.',
      });

      return;
    }

    setIsSending(true);

    try {
      const response = await fetch(
        `${REACT_APP_SERVER_BASE_URL}/rest/integrations/plusvibe/send-leads`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', ...authHeader },
          body: JSON.stringify({
            matchAllFilters: true,
            campaignId: selectedCampaignId,
            filters: {
              companyRevenues: Array.from(selectedRevenues),
              minAgeDays: minAgeDays ? Number(minAgeDays) : undefined,
              maxAgeDays: maxAgeDays ? Number(maxAgeDays) : undefined,
            },
          }),
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
        message: `PlusVibe: ${json.sent ?? 0} sent, ${json.skipped ?? 0} already synced, ${json.filtered ?? 0} filtered (no email or revenue mismatch), ${json.failed ?? 0} failed.`,
      });
    } catch (error) {
      enqueueErrorSnackBar({ message: 'Failed to push leads to PlusVibe.' });
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
        PlusVibe is email-only — leads without a valid email get filtered out.
        Already-pushed leads are skipped automatically. Capped at 1000 per send.
      </StyledNote>

      <StyledLabel htmlFor="plusvibe-campaign-select">Campaign</StyledLabel>
      <StyledSelect
        id="plusvibe-campaign-select"
        value={selectedCampaignId ?? ''}
        onChange={(e) => setSelectedCampaignId(e.target.value)}
        disabled={isLoadingCampaigns || campaigns.length === 0}
      >
        {isLoadingCampaigns && <option>Loading campaigns…</option>}
        {!isLoadingCampaigns && campaigns.length === 0 && (
          <option>No campaigns — create one in PlusVibe first</option>
        )}
        {campaigns.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name} {c.status ? `(${c.status})` : ''}
          </option>
        ))}
      </StyledSelect>

      <StyledDivider />

      <StyledLabel>Filters</StyledLabel>

      <StyledLabel htmlFor="plusvibe-country-filter">Country</StyledLabel>
      <StyledSelect
        id="plusvibe-country-filter"
        value={countryFilter}
        onChange={(e) =>
          setCountryFilter(e.target.value as 'all' | 'us' | 'non_us')
        }
      >
        <option value="all">All</option>
        <option value="us">US only (phone is +1 NANP)</option>
        <option value="non_us">Non-US only</option>
      </StyledSelect>

      <StyledLabel>Skip leads added in the last N days</StyledLabel>
      <StyledInput
        type="number"
        inputMode="numeric"
        placeholder="30"
        min={0}
        value={minAgeDays}
        onChange={(e) => setMinAgeDays(e.target.value)}
      />

      <StyledLabel>Only leads added within the last N days</StyledLabel>
      <StyledInput
        type="number"
        inputMode="numeric"
        placeholder="90"
        min={1}
        value={maxAgeDays}
        onChange={(e) => setMaxAgeDays(e.target.value)}
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
                  <th>Email</th>
                  <th>Revenue</th>
                  <th>Added</th>
                </tr>
              </thead>
              <tbody>
                {sample.map((row) => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td>{row.email}</td>
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
      title="Send to PlusVibe"
      subtitle={subtitle}
      onConfirmClick={handleSend}
      confirmButtonText="Send to PlusVibe"
      confirmButtonAccent="blue"
      isLoading={isSending}
      size="large"
    />
  );
};
