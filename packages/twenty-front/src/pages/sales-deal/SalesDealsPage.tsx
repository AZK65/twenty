import { getTokenPair } from '@/apollo/utils/getTokenPair';
import { PageTitle } from '@/ui/utilities/page-title/components/PageTitle';
import { styled } from '@linaria/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { themeCssVariables } from 'twenty-ui/theme-constants';
import { REACT_APP_SERVER_BASE_URL } from '~/config';

type SalesDeal = {
  id: string;
  sourceOpportunityId: string;
  position: number;
  name: string;
  brand: string;
  companyRevenue: string;
  appticsCrm: string;
  stage: string;
  leadSource: string;
  salesRep: string;
  mrr: number | null;
  jakePay: number | null;
  finityPay: number | null;
  notes: string;
  createdAt: string;
  updatedAt: string;
};

type EditableField =
  | 'brand'
  | 'leadSource'
  | 'mrr'
  | 'jakePay'
  | 'finityPay'
  | 'notes';

const apiBase = `${REACT_APP_SERVER_BASE_URL}/rest/sales-deals`;

const authHeaders = () => {
  const token = getTokenPair()?.accessOrWorkspaceAgnosticToken?.token;

  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
};

const api = {
  list: async (): Promise<SalesDeal[]> => {
    const response = await fetch(apiBase, { headers: authHeaders() });

    if (!response.ok) {
      return [];
    }

    return response.json();
  },
  update: async (
    id: string,
    patch: Partial<Record<EditableField, string | number | null>>,
  ): Promise<void> => {
    await fetch(`${apiBase}/${id}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(patch),
    });
  },
  reorder: async (orderedIds: string[]): Promise<void> => {
    await fetch(`${apiBase}/reorder`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ orderedIds }),
    });
  },
  remove: async (id: string): Promise<void> => {
    await fetch(`${apiBase}/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
  },
};

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 2,
});

const formatCurrency = (value: number | null): string =>
  value === null || Number.isNaN(value) ? '—' : usdFormatter.format(value);

const StyledContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
  overflow: auto;
  padding: 24px;
`;

const StyledHeader = styled.h1`
  font-size: 20px;
  font-weight: 600;
  margin: 0;
`;

const StyledTable = styled.table`
  border-collapse: collapse;
  font-size: 13px;
  width: 100%;

  th,
  td {
    border: 1px solid ${themeCssVariables.border.color.light};
    padding: 6px 8px;
    text-align: left;
    white-space: nowrap;
  }

  th {
    background: ${themeCssVariables.background.secondary};
    font-weight: 600;
  }

  tfoot td {
    background: ${themeCssVariables.background.secondary};
    font-weight: 600;
    position: sticky;
    bottom: 0;
  }
`;

const StyledReadOnlyCell = styled.td`
  color: ${themeCssVariables.font.color.secondary};
`;

const StyledInput = styled.input`
  background: transparent;
  border: none;
  color: inherit;
  font-size: 13px;
  outline: none;
  width: 100%;

  &:focus {
    background: ${themeCssVariables.background.tertiary};
  }
`;

const StyledControls = styled.div`
  display: flex;
  gap: 4px;
`;

const StyledControlButton = styled.button`
  background: ${themeCssVariables.background.secondary};
  border: 1px solid ${themeCssVariables.border.color.medium};
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
  padding: 2px 6px;
`;

const StyledEmptyState = styled.div`
  color: ${themeCssVariables.font.color.secondary};
  padding: 32px 0;
  text-align: center;
`;

export const SalesDealsPage = () => {
  const [deals, setDeals] = useState<SalesDeal[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const refresh = useCallback(async () => {
    setIsLoading(true);
    setDeals(await api.list());
    setIsLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totals = useMemo(
    () =>
      deals.reduce(
        (accumulator, deal) => ({
          mrr: accumulator.mrr + (deal.mrr ?? 0),
          jakePay: accumulator.jakePay + (deal.jakePay ?? 0),
          finityPay: accumulator.finityPay + (deal.finityPay ?? 0),
        }),
        { mrr: 0, jakePay: 0, finityPay: 0 },
      ),
    [deals],
  );

  const handleEdit = (id: string, field: EditableField, rawValue: string) => {
    const isMoneyField =
      field === 'mrr' || field === 'jakePay' || field === 'finityPay';
    const value: string | number | null = isMoneyField
      ? rawValue === ''
        ? null
        : Number(rawValue)
      : rawValue;

    setDeals((previous) =>
      previous.map((deal) =>
        deal.id === id ? { ...deal, [field]: value } : deal,
      ),
    );
  };

  const handleCommit = (id: string, field: EditableField) => {
    const deal = deals.find((candidate) => candidate.id === id);

    if (deal === undefined) {
      return;
    }

    void api.update(id, { [field]: deal[field] });
  };

  const handleMove = async (index: number, direction: -1 | 1) => {
    const target = index + direction;

    if (target < 0 || target >= deals.length) {
      return;
    }

    const reordered = [...deals];
    [reordered[index], reordered[target]] = [
      reordered[target],
      reordered[index],
    ];

    setDeals(reordered);
    await api.reorder(reordered.map((deal) => deal.id));
  };

  const handleDelete = async (id: string, name: string) => {
    if (!window.confirm(`Delete "${name || 'this deal'}" from the sheet?`)) {
      return;
    }

    await api.remove(id);
    setDeals((previous) => previous.filter((deal) => deal.id !== id));
  };

  return (
    <StyledContainer>
      <PageTitle title="Sales Deals" />
      <StyledHeader>Sales Deals</StyledHeader>

      {isLoading ? null : deals.length === 0 ? (
        <StyledEmptyState>
          No deals yet. When an opportunity is marked Won in the CRM, it shows
          up here automatically.
        </StyledEmptyState>
      ) : (
        <StyledTable>
          <thead>
            <tr>
              <th>#</th>
              <th>Name</th>
              <th>Brand</th>
              <th>Company Revenue</th>
              <th>Apptics CRM</th>
              <th>Stage</th>
              <th>Lead Source</th>
              <th>Sales Rep</th>
              <th>MRR</th>
              <th>Jake Pay</th>
              <th>Finity Pay</th>
              <th>Notes</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {deals.map((deal, index) => (
              <tr key={deal.id}>
                <td>{index + 1}</td>
                <StyledReadOnlyCell>{deal.name}</StyledReadOnlyCell>
                <td>
                  <StyledInput
                    value={deal.brand}
                    onChange={(event) =>
                      handleEdit(deal.id, 'brand', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'brand')}
                  />
                </td>
                <StyledReadOnlyCell>{deal.companyRevenue}</StyledReadOnlyCell>
                <StyledReadOnlyCell>{deal.appticsCrm}</StyledReadOnlyCell>
                <StyledReadOnlyCell>{deal.stage}</StyledReadOnlyCell>
                <td>
                  <StyledInput
                    value={deal.leadSource}
                    onChange={(event) =>
                      handleEdit(deal.id, 'leadSource', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'leadSource')}
                  />
                </td>
                <StyledReadOnlyCell>{deal.salesRep}</StyledReadOnlyCell>
                <td>
                  <StyledInput
                    type="number"
                    value={deal.mrr ?? ''}
                    onChange={(event) =>
                      handleEdit(deal.id, 'mrr', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'mrr')}
                  />
                </td>
                <td>
                  <StyledInput
                    type="number"
                    value={deal.jakePay ?? ''}
                    onChange={(event) =>
                      handleEdit(deal.id, 'jakePay', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'jakePay')}
                  />
                </td>
                <td>
                  <StyledInput
                    type="number"
                    value={deal.finityPay ?? ''}
                    onChange={(event) =>
                      handleEdit(deal.id, 'finityPay', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'finityPay')}
                  />
                </td>
                <td>
                  <StyledInput
                    value={deal.notes}
                    onChange={(event) =>
                      handleEdit(deal.id, 'notes', event.target.value)
                    }
                    onBlur={() => handleCommit(deal.id, 'notes')}
                  />
                </td>
                <td>
                  <StyledControls>
                    <StyledControlButton
                      onClick={() => handleMove(index, -1)}
                      disabled={index === 0}
                    >
                      ↑
                    </StyledControlButton>
                    <StyledControlButton
                      onClick={() => handleMove(index, 1)}
                      disabled={index === deals.length - 1}
                    >
                      ↓
                    </StyledControlButton>
                    <StyledControlButton
                      onClick={() => handleDelete(deal.id, deal.name)}
                    >
                      ✕
                    </StyledControlButton>
                  </StyledControls>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td colSpan={8}>Grand Total</td>
              <td>{formatCurrency(totals.mrr)}</td>
              <td>{formatCurrency(totals.jakePay)}</td>
              <td>{formatCurrency(totals.finityPay)}</td>
              <td colSpan={2} />
            </tr>
          </tfoot>
        </StyledTable>
      )}
    </StyledContainer>
  );
};
