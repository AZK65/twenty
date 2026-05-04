import { Fragment } from 'react';

import { BaseEmail } from 'src/components/BaseEmail';
import { CallToAction } from 'src/components/CallToAction';
import { MainText } from 'src/components/MainText';
import { Title } from 'src/components/Title';
import { type APP_LOCALES } from 'twenty-shared/translations';

export type RecordUpdateChange = {
  field: string;
  before?: string | null;
  after?: string | null;
};

export type RecordUpdateEventType =
  | 'fieldUpdated'
  | 'noteAdded'
  | 'taskAdded'
  | 'assigned'
  | 'unassigned';

type RecordUpdateNotificationEmailProps = {
  recipientFirstName: string;
  recordType: 'Lead' | 'Client' | 'Loss';
  recordName: string;
  recordUrl: string;
  eventType: RecordUpdateEventType;
  actorName?: string | null;
  changes?: RecordUpdateChange[];
  noteTitle?: string | null;
  noteBody?: string | null;
  taskTitle?: string | null;
  locale: keyof typeof APP_LOCALES;
};

const headlineFor = (
  eventType: RecordUpdateEventType,
  recordType: string,
  recordName: string,
): string => {
  switch (eventType) {
    case 'assigned':
      return `You were assigned a ${recordType.toLowerCase()}: ${recordName}`;
    case 'unassigned':
      return `You were unassigned from ${recordType.toLowerCase()}: ${recordName}`;
    case 'noteAdded':
      return `New note on ${recordType.toLowerCase()}: ${recordName}`;
    case 'taskAdded':
      return `New task on ${recordType.toLowerCase()}: ${recordName}`;
    case 'fieldUpdated':
    default:
      return `Update on ${recordType.toLowerCase()}: ${recordName}`;
  }
};

const formatValue = (value?: string | null): string => {
  if (value === null || value === undefined || value === '') return '—';
  return value;
};

const summaryLine = (
  eventType: RecordUpdateEventType,
  recordName: string,
  actorName: string,
): string => {
  switch (eventType) {
    case 'assigned':
      return `You have been assigned to "${recordName}".`;
    case 'unassigned':
      return `You are no longer assigned to "${recordName}".`;
    case 'fieldUpdated':
      return `${actorName} updated "${recordName}".`;
    case 'noteAdded':
      return `${actorName} added a note to "${recordName}".`;
    case 'taskAdded':
      return `${actorName} added a task to "${recordName}".`;
    default:
      return '';
  }
};

export const RecordUpdateNotificationEmail = ({
  recipientFirstName,
  recordType,
  recordName,
  recordUrl,
  eventType,
  actorName,
  changes,
  noteTitle,
  noteBody,
  taskTitle,
  locale,
}: RecordUpdateNotificationEmailProps) => {
  const headline = headlineFor(eventType, recordType, recordName);
  const greetingName =
    recipientFirstName?.length > 0 ? recipientFirstName : 'there';
  const actor = actorName && actorName.length > 0 ? actorName : 'Someone';

  const summary = (
    <Fragment>
      Hi {greetingName},
      <br />
      <br />
      {summaryLine(eventType, recordName, actor)}
      <br />
    </Fragment>
  );

  const changesBlock =
    eventType === 'fieldUpdated' && changes && changes.length > 0 ? (
      <MainText>
        <Fragment>
          <br />
          <strong>Changes:</strong>
          <br />
          {changes.map((c, idx) => (
            <Fragment key={`${c.field}-${idx}`}>
              <br />
              <strong>{c.field}:</strong> {formatValue(c.before)}
              {' → '}
              {formatValue(c.after)}
            </Fragment>
          ))}
          <br />
        </Fragment>
      </MainText>
    ) : (
      <Fragment />
    );

  const noteBlock =
    eventType === 'noteAdded' && (noteTitle || noteBody) ? (
      <MainText>
        <Fragment>
          <br />
          <strong>{noteTitle ?? ''}</strong>
          <br />
          {noteBody ?? ''}
          <br />
        </Fragment>
      </MainText>
    ) : (
      <Fragment />
    );

  const taskBlock =
    eventType === 'taskAdded' && taskTitle ? (
      <MainText>
        <Fragment>
          <br />
          <strong>{taskTitle}</strong>
          <br />
        </Fragment>
      </MainText>
    ) : (
      <Fragment />
    );

  return (
    <BaseEmail locale={locale}>
      <Title value={headline} />
      <MainText>{summary}</MainText>
      {changesBlock}
      {noteBlock}
      {taskBlock}
      <CallToAction
        value={`Open ${recordType.toLowerCase()}`}
        href={recordUrl}
      />
    </BaseEmail>
  );
};

RecordUpdateNotificationEmail.PreviewProps = {
  recipientFirstName: 'Sarah',
  recordType: 'Lead',
  recordName: 'Acme Corp - John Doe',
  recordUrl: 'https://app.twenty.com/object/lead/123',
  eventType: 'fieldUpdated',
  actorName: 'Mike Smith',
  changes: [
    { field: 'stage', before: 'CONTACTED', after: 'QUALIFIED' },
    { field: 'priority', before: 'LOW', after: 'HIGH' },
  ],
  locale: 'en',
} as RecordUpdateNotificationEmailProps;

export default RecordUpdateNotificationEmail;
