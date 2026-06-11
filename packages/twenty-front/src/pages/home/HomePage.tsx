import { getTokenPair } from '@/apollo/utils/getTokenPair';
import { PageTitle } from '@/ui/utilities/page-title/components/PageTitle';
import { styled } from '@linaria/react';
import { useCallback, useEffect, useState } from 'react';
import { themeCssVariables } from 'twenty-ui/theme-constants';
import { REACT_APP_SERVER_BASE_URL } from '~/config';

type LabelValue = { label: string; value: number };

type HomeMetrics = {
  dealsByCompany: LabelValue[];
  closePercent: number;
  pipelineValueByStage: LabelValue[];
  leadSource: LabelValue[];
  dealsCreatedThisMonth: number;
  dealsWonThisMonth: number;
  dealsLostThisMonth: number;
  dealValueCreatedThisMonth: number;
};

const authHeaders = () => {
  const token = getTokenPair()?.accessOrWorkspaceAgnosticToken?.token;

  return token ? { Authorization: `Bearer ${token}` } : {};
};

const usdFormatter = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
});

const StyledContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: 24px;
  height: 100%;
  overflow: auto;
  padding: 24px;
`;

const StyledHeader = styled.h1`
  font-size: 22px;
  font-weight: 700;
  margin: 0;
`;

const StyledStatGrid = styled.div`
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
`;

const StyledChartGrid = styled.div`
  display: grid;
  gap: 16px;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
`;

const StyledCard = styled.div`
  background: ${themeCssVariables.background.secondary};
  border: 1px solid ${themeCssVariables.border.color.light};
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
`;

const StyledCardLabel = styled.div`
  color: ${themeCssVariables.font.color.secondary};
  font-size: 13px;
  font-weight: 500;
`;

const StyledStatValue = styled.div`
  font-size: 28px;
  font-weight: 700;
`;

const StyledBarRow = styled.div`
  align-items: center;
  display: grid;
  gap: 8px;
  grid-template-columns: 120px 1fr 56px;
`;

const StyledBarLabel = styled.div`
  color: ${themeCssVariables.font.color.secondary};
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
`;

const StyledBarTrack = styled.div`
  background: ${themeCssVariables.background.tertiary};
  border-radius: 4px;
  height: 12px;
  overflow: hidden;
`;

const StyledBarFill = styled.div`
  background: ${themeCssVariables.color.blue};
  border-radius: 4px;
  height: 100%;
`;

const StyledBarValue = styled.div`
  font-size: 12px;
  font-weight: 600;
  text-align: right;
`;

const StyledEmpty = styled.div`
  color: ${themeCssVariables.font.color.light};
  font-size: 12px;
`;

const StatCard = ({ label, value }: { label: string; value: string }) => (
  <StyledCard>
    <StyledCardLabel>{label}</StyledCardLabel>
    <StyledStatValue>{value}</StyledStatValue>
  </StyledCard>
);

const BarChartCard = ({
  label,
  data,
  format,
}: {
  label: string;
  data: LabelValue[];
  format?: (value: number) => string;
}) => {
  const max = Math.max(1, ...data.map((item) => item.value));

  return (
    <StyledCard>
      <StyledCardLabel>{label}</StyledCardLabel>
      {data.length === 0 ? (
        <StyledEmpty>No data yet.</StyledEmpty>
      ) : (
        data.map((item) => (
          <StyledBarRow key={item.label}>
            <StyledBarLabel title={item.label}>{item.label}</StyledBarLabel>
            <StyledBarTrack>
              <StyledBarFill
                style={{ width: `${(item.value / max) * 100}%` }}
              />
            </StyledBarTrack>
            <StyledBarValue>
              {format ? format(item.value) : item.value}
            </StyledBarValue>
          </StyledBarRow>
        ))
      )}
    </StyledCard>
  );
};

export const HomePage = () => {
  const [metrics, setMetrics] = useState<HomeMetrics | null>(null);

  const refresh = useCallback(async () => {
    const response = await fetch(
      `${REACT_APP_SERVER_BASE_URL}/rest/home-metrics`,
      { headers: authHeaders() },
    );

    if (response.ok) {
      setMetrics(await response.json());
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <StyledContainer>
      <PageTitle title="Home" />
      <StyledHeader>Home</StyledHeader>

      {metrics === null ? null : (
        <>
          <StyledStatGrid>
            <StatCard label="Close %" value={`${metrics.closePercent}%`} />
            <StatCard
              label="Deals Created This Month"
              value={String(metrics.dealsCreatedThisMonth)}
            />
            <StatCard
              label="Deals Won This Month"
              value={String(metrics.dealsWonThisMonth)}
            />
            <StatCard
              label="Deals Lost This Month"
              value={String(metrics.dealsLostThisMonth)}
            />
            <StatCard
              label="Deal Value Created This Month"
              value={usdFormatter.format(metrics.dealValueCreatedThisMonth)}
            />
          </StyledStatGrid>

          <StyledChartGrid>
            <BarChartCard
              label="Deals by Company"
              data={metrics.dealsByCompany}
            />
            <BarChartCard
              label="Pipeline Value by Stage"
              data={metrics.pipelineValueByStage}
              format={(value) => usdFormatter.format(value)}
            />
            <BarChartCard label="Lead Source" data={metrics.leadSource} />
          </StyledChartGrid>
        </>
      )}
    </StyledContainer>
  );
};
