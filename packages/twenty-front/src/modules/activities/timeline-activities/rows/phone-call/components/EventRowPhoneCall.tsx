import { styled } from '@linaria/react';
import { t } from '@lingui/core/macro';
import { useState } from 'react';

import { EventCard } from '@/activities/timeline-activities/rows/components/EventCard';
import { EventCardToggleButton } from '@/activities/timeline-activities/rows/components/EventCardToggleButton';
import {
  type EventRowDynamicComponentProps,
  StyledEventRowItemAction,
  StyledEventRowItemColumn,
} from '@/activities/timeline-activities/rows/components/EventRowDynamicComponent';
import { themeCssVariables } from 'twenty-ui/theme-constants';

type PhoneCallProperties = {
  direction?: string;
  outcome?: string;
  disposition?: string;
  durationSeconds?: number;
  agentName?: string;
  agentEmail?: string;
  justcallNumber?: string;
  contactNumber?: string;
  campaignName?: string;
  recordingUrl?: string;
  agentNotes?: string;
  transcript?: string;
  transcriptAgent?: string;
  transcriptLead?: string;
  summary?: string;
  sentiment?: string;
  callScore?: number;
  actionItems?: string[];
  justcallCallId?: string | number;
};

const StyledContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledRow = styled.div`
  display: flex;
  flex-direction: row;
  gap: ${themeCssVariables.spacing[1]};
  align-items: center;
  flex-wrap: wrap;
`;

const StyledCardBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[3]};
  padding: ${themeCssVariables.spacing[3]};
`;

const StyledSection = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledSectionTitle = styled.div`
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.xs};
  font-weight: ${themeCssVariables.font.weight.medium};
  text-transform: uppercase;
`;

const StyledSectionBody = styled.div`
  color: ${themeCssVariables.font.color.primary};
  font-size: ${themeCssVariables.font.size.sm};
  white-space: pre-wrap;
  line-height: 1.5;
`;

const StyledMetaPill = styled.span`
  background: ${themeCssVariables.background.secondary};
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.xs};
  padding: 2px 6px;
`;

const StyledAudio = styled.audio`
  width: 100%;
`;

const StyledList = styled.ul`
  margin: 0;
  padding-left: ${themeCssVariables.spacing[4]};
`;

const formatDuration = (seconds?: number): string => {
  if (!seconds || seconds <= 0) return '0s';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  if (mins === 0) return `${secs}s`;

  return `${mins}m ${secs}s`;
};

type EventRowPhoneCallProps = EventRowDynamicComponentProps;

export const EventRowPhoneCall = ({
  event,
  authorFullName,
}: EventRowPhoneCallProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const props = (event.properties ?? {}) as PhoneCallProperties;

  const outcomeText = props.disposition ?? props.outcome ?? 'Call completed';
  const durationText = formatDuration(props.durationSeconds);
  const headlineAuthor = props.agentName ?? authorFullName;

  return (
    <StyledContainer>
      <StyledRow>
        <StyledEventRowItemColumn>{headlineAuthor}</StyledEventRowItemColumn>
        <StyledEventRowItemAction>
          {t`made a call —`}
        </StyledEventRowItemAction>
        <StyledEventRowItemColumn>{outcomeText}</StyledEventRowItemColumn>
        <StyledMetaPill>{durationText}</StyledMetaPill>
        {props.campaignName !== undefined && (
          <StyledMetaPill>{props.campaignName}</StyledMetaPill>
        )}
        {props.sentiment !== undefined && (
          <StyledMetaPill>{props.sentiment}</StyledMetaPill>
        )}
        <EventCardToggleButton isOpen={isOpen} setIsOpen={setIsOpen} />
      </StyledRow>
      <EventCard isOpen={isOpen}>
        <StyledCardBody>
          {props.summary !== undefined && (
            <StyledSection>
              <StyledSectionTitle>{t`Summary`}</StyledSectionTitle>
              <StyledSectionBody>{props.summary}</StyledSectionBody>
            </StyledSection>
          )}

          <StyledSection>
            <StyledSectionTitle>{t`Details`}</StyledSectionTitle>
            <StyledSectionBody>
              {props.agentName !== undefined && (
                <div>
                  {t`Agent`}: {props.agentName}
                </div>
              )}
              {props.contactNumber !== undefined && (
                <div>
                  {t`Called`}: {props.contactNumber}
                </div>
              )}
              {props.justcallNumber !== undefined && (
                <div>
                  {t`From line`}: {props.justcallNumber}
                </div>
              )}
              {props.callScore !== undefined && (
                <div>
                  {t`Call score`}: {props.callScore}
                </div>
              )}
            </StyledSectionBody>
          </StyledSection>

          {props.recordingUrl !== undefined && (
            <StyledSection>
              <StyledSectionTitle>{t`Recording`}</StyledSectionTitle>
              <StyledAudio controls preload="none" src={props.recordingUrl} />
            </StyledSection>
          )}

          {props.agentNotes !== undefined && (
            <StyledSection>
              <StyledSectionTitle>{t`Agent notes`}</StyledSectionTitle>
              <StyledSectionBody>{props.agentNotes}</StyledSectionBody>
            </StyledSection>
          )}

          {props.actionItems !== undefined && props.actionItems.length > 0 && (
            <StyledSection>
              <StyledSectionTitle>{t`Action items`}</StyledSectionTitle>
              <StyledList>
                {props.actionItems.map((item, idx) => (
                  <li key={idx}>{item}</li>
                ))}
              </StyledList>
            </StyledSection>
          )}

          {props.transcript !== undefined && (
            <StyledSection>
              <StyledSectionTitle>{t`Transcript`}</StyledSectionTitle>
              <StyledSectionBody>{props.transcript}</StyledSectionBody>
            </StyledSection>
          )}
        </StyledCardBody>
      </EventCard>
    </StyledContainer>
  );
};
