export type LeadSequenceStepType =
  | 'SEND_EMAIL'
  | 'CREATE_TASK'
  | 'SEND_NOTIFICATION';

export type LeadSequenceStep = {
  type: LeadSequenceStepType;
  // Delay in minutes relative to stage transition. Negative values mean before
  // an associated event (e.g. a scheduled call).
  delay: number;
  template?: string;
  description: string;
};

export type LeadStageSequence = {
  name: string;
  steps: LeadSequenceStep[];
};

export const LEAD_STAGE_SEQUENCES: Record<string, LeadStageSequence> = {
  NEW: {
    name: 'New Lead Intake',
    steps: [
      {
        type: 'SEND_EMAIL',
        delay: 0,
        template: 'lead-welcome',
        description: 'Send welcome/acknowledgment email',
      },
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Create task: Review lead details',
      },
      {
        type: 'SEND_NOTIFICATION',
        delay: 0,
        description: 'Notify assigned team member',
      },
    ],
  },
  CONTACTED: {
    name: 'Initial Contact Follow-up',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 24 * 60,
        description: 'Follow up if no response (24h)',
      },
      {
        type: 'SEND_EMAIL',
        delay: 48 * 60,
        template: 'lead-followup-1',
        description: 'Send follow-up email (48h)',
      },
    ],
  },
  QUALIFIED: {
    name: 'Qualification Process',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Schedule qualification call',
      },
      {
        type: 'SEND_EMAIL',
        delay: 0,
        template: 'lead-qualified',
        description: 'Send qualification confirmation',
      },
    ],
  },
  PRE_CALL: {
    name: 'Pre-Call Preparation',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Research lead company and needs',
      },
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Prepare call agenda and talking points',
      },
      {
        type: 'SEND_EMAIL',
        delay: 0,
        template: 'lead-precall-reminder',
        description: 'Send call reminder to lead',
      },
      {
        type: 'SEND_NOTIFICATION',
        delay: -30,
        description: 'Remind team member 30min before call',
      },
    ],
  },
  MEETING_SCHEDULED: {
    name: 'Meeting Preparation',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Prepare meeting materials and demo',
      },
      {
        type: 'SEND_EMAIL',
        delay: 0,
        template: 'lead-meeting-confirmation',
        description: 'Send meeting confirmation',
      },
      {
        type: 'SEND_EMAIL',
        delay: -60,
        template: 'lead-meeting-reminder',
        description: 'Send meeting reminder (1h before)',
      },
    ],
  },
  PROPOSAL: {
    name: 'Proposal Follow-up',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Draft and send proposal',
      },
      {
        type: 'SEND_EMAIL',
        delay: 72 * 60,
        template: 'lead-proposal-followup',
        description: 'Follow up on proposal (72h)',
      },
      {
        type: 'CREATE_TASK',
        delay: 120 * 60,
        description: 'Escalate if no proposal response (5 days)',
      },
    ],
  },
  NEGOTIATION: {
    name: 'Negotiation Process',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Review negotiation terms',
      },
      {
        type: 'CREATE_TASK',
        delay: 48 * 60,
        description: 'Check negotiation progress (48h)',
      },
    ],
  },
  WON: {
    name: 'Won - Onboarding',
    steps: [
      {
        type: 'SEND_EMAIL',
        delay: 0,
        template: 'lead-won-welcome',
        description: 'Send welcome aboard email',
      },
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Begin client onboarding process',
      },
      {
        type: 'SEND_NOTIFICATION',
        delay: 0,
        description: 'Notify team of won lead',
      },
    ],
  },
  LOST: {
    name: 'Lost - Nurture',
    steps: [
      {
        type: 'CREATE_TASK',
        delay: 0,
        description: 'Log loss reason and learnings',
      },
      {
        type: 'SEND_EMAIL',
        delay: 30 * 24 * 60,
        template: 'lead-nurture-checkin',
        description: 'Check in after 30 days',
      },
    ],
  },
};
