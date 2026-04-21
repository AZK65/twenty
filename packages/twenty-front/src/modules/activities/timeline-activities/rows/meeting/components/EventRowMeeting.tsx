import { styled } from '@linaria/react';
import { useState } from 'react';

import { EventCard } from '@/activities/timeline-activities/rows/components/EventCard';
import { EventCardToggleButton } from '@/activities/timeline-activities/rows/components/EventCardToggleButton';
import {
  type EventRowDynamicComponentProps,
  StyledEventRowItemAction,
  StyledEventRowItemColumn,
} from '@/activities/timeline-activities/rows/components/EventRowDynamicComponent';
import { themeCssVariables } from 'twenty-ui/theme-constants';

type MeetingProperties = {
  tldvMeetingId?: string;
  tldvMeetingName?: string;
  tldvUrl?: string;
  durationSeconds?: number;
  organizer?: { name?: string; email?: string };
  invitees?: Array<{ name?: string; email?: string }>;
  noteId?: string;
  hasAiSummary?: boolean;
};

const StyledContainer = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledRow = styled.div`
  align-items: center;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  gap: ${themeCssVariables.spacing[1]};
`;

const StyledPill = styled.span`
  background: ${themeCssVariables.background.secondary};
  border-radius: ${themeCssVariables.border.radius.sm};
  color: ${themeCssVariables.font.color.secondary};
  font-size: ${themeCssVariables.font.size.xs};
  padding: 2px 6px;
`;

const StyledCardBody = styled.div`
  display: flex;
  flex-direction: column;
  gap: ${themeCssVariables.spacing[2]};
  padding: ${themeCssVariables.spacing[3]};
`;

const StyledRowInline = styled.div`
  color: ${themeCssVariables.font.color.primary};
  font-size: ${themeCssVariables.font.size.sm};
`;

const StyledLink = styled.a`
  color: ${themeCssVariables.color.blue};
  text-decoration: none;
  &:hover {
    text-decoration: underline;
  }
`;

const formatDuration = (seconds?: number): string => {
  if (!seconds || seconds <= 0) return '0m';
  const mins = Math.round(seconds / 60);

  return `${mins}m`;
};

export const EventRowMeeting = ({
  event,
  authorFullName,
}: EventRowDynamicComponentProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const props = (event.properties ?? {}) as MeetingProperties;

  const headline = props.organizer?.name ?? authorFullName;
  const meetingName = props.tldvMeetingName ?? 'Meeting';
  const attendees = (props.invitees ?? [])
    .map((i) => i.name || i.email)
    .filter(Boolean)
    .join(', ');

  return (
    <StyledContainer>
      <StyledRow>
        <StyledEventRowItemColumn>{headline}</StyledEventRowItemColumn>
        <StyledEventRowItemAction>ran a meeting —</StyledEventRowItemAction>
        <StyledEventRowItemColumn>{meetingName}</StyledEventRowItemColumn>
        <StyledPill>{formatDuration(props.durationSeconds)}</StyledPill>
        {props.hasAiSummary && <StyledPill>AI notes</StyledPill>}
        <EventCardToggleButton isOpen={isOpen} setIsOpen={setIsOpen} />
      </StyledRow>
      <EventCard isOpen={isOpen}>
        <StyledCardBody>
          {attendees && (
            <StyledRowInline>
              <strong>Attendees:</strong> {attendees}
            </StyledRowInline>
          )}
          {props.organizer?.email && (
            <StyledRowInline>
              <strong>Organizer:</strong> {props.organizer.name} ({props.organizer.email})
            </StyledRowInline>
          )}
          {props.tldvUrl && (
            <StyledRowInline>
              <StyledLink href={props.tldvUrl} target="_blank" rel="noopener noreferrer">
                Watch on TLDV ↗
              </StyledLink>
            </StyledRowInline>
          )}
        </StyledCardBody>
      </EventCard>
    </StyledContainer>
  );
};
