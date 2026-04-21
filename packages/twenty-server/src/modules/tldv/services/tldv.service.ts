import { Injectable, Logger } from '@nestjs/common';

// TLDV (tl;dv) API client.
// Base: https://pasta.tldv.io
// Auth: x-api-key header
// Env: TLDV_API_KEY

const TLDV_API_BASE = 'https://pasta.tldv.io/v1alpha1';

export type TldvMeeting = {
  id: string;
  name: string;
  happenedAt: string;
  duration?: number;
  url?: string;
  organizer?: { name?: string; email?: string };
  invitees?: Array<{ name?: string; email?: string }>;
  extraProperties?: { conferenceId?: string };
};

export type TldvNotes = {
  structuredNotes: Array<{
    segmentId?: string;
    timestamp?: number;
    text?: string;
    topicId?: string;
  }>;
  markdownContent: string | null;
  topics: Array<{ id: string; order: number; title: string; summary: string }>;
};

export type TldvHighlights = {
  meetingId: string;
  data: Array<{
    text?: string;
    startTime?: number;
    endTime?: number;
    type?: string;
  }>;
};

@Injectable()
export class TldvService {
  private readonly logger = new Logger(TldvService.name);

  private getHeaders(): Record<string, string> | null {
    const apiKey = process.env.TLDV_API_KEY;

    if (!apiKey) {
      this.logger.warn('TLDV_API_KEY not configured');

      return null;
    }

    return { 'x-api-key': apiKey, Accept: 'application/json' };
  }

  async getMeeting(meetingId: string): Promise<TldvMeeting | null> {
    const headers = this.getHeaders();

    if (!headers) return null;

    try {
      const response = await fetch(`${TLDV_API_BASE}/meetings/${meetingId}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        this.logger.warn(
          `TLDV getMeeting ${meetingId} failed: ${response.status}`,
        );

        return null;
      }

      return (await response.json()) as TldvMeeting;
    } catch (error) {
      this.logger.error(
        `TLDV getMeeting error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  async getNotes(meetingId: string): Promise<TldvNotes | null> {
    const headers = this.getHeaders();

    if (!headers) return null;

    try {
      const response = await fetch(
        `${TLDV_API_BASE}/meetings/${meetingId}/notes`,
        { method: 'GET', headers, signal: AbortSignal.timeout(15_000) },
      );

      if (!response.ok || response.status === 204) return null;

      return (await response.json()) as TldvNotes;
    } catch (error) {
      this.logger.warn(
        `TLDV getNotes error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  async getHighlights(meetingId: string): Promise<TldvHighlights | null> {
    const headers = this.getHeaders();

    if (!headers) return null;

    try {
      const response = await fetch(
        `${TLDV_API_BASE}/meetings/${meetingId}/highlights`,
        { method: 'GET', headers, signal: AbortSignal.timeout(15_000) },
      );

      if (!response.ok) return null;

      return (await response.json()) as TldvHighlights;
    } catch (error) {
      this.logger.warn(
        `TLDV getHighlights error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }
}
