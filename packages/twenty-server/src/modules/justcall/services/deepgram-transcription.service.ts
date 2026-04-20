import { Injectable, Logger } from '@nestjs/common';

// Deepgram speech-to-text with multichannel stereo support.
// JustCall ships dual-channel recordings (agent = ch0, lead = ch1),
// so we request multichannel=true which gives per-channel transcription.
//
// Environment variables:
//   DEEPGRAM_API_KEY — Deepgram API key

const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

type DeepgramAlternative = {
  transcript?: string;
  confidence?: number;
};

type DeepgramChannel = {
  alternatives?: DeepgramAlternative[];
};

type DeepgramResults = {
  channels?: DeepgramChannel[];
};

type DeepgramResponse = {
  results?: DeepgramResults;
  metadata?: { duration?: number };
  err_msg?: string;
};

export type TranscriptionResult = {
  full: string;
  agent?: string;
  lead?: string;
  durationSeconds?: number;
};

@Injectable()
export class DeepgramTranscriptionService {
  private readonly logger = new Logger(DeepgramTranscriptionService.name);

  async transcribeFromUrl(recordingUrl: string): Promise<TranscriptionResult | null> {
    const apiKey = process.env.DEEPGRAM_API_KEY;

    if (!apiKey) {
      this.logger.debug('DEEPGRAM_API_KEY not set — skipping transcription');

      return null;
    }

    try {
      const params = new URLSearchParams({
        model: 'nova-3',
        multichannel: 'true',
        punctuate: 'true',
        smart_format: 'true',
        language: 'en',
      });

      const response = await fetch(`${DEEPGRAM_URL}?${params.toString()}`, {
        method: 'POST',
        headers: {
          Authorization: `Token ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ url: recordingUrl }),
        signal: AbortSignal.timeout(120_000),
      });

      if (!response.ok) {
        const text = await response.text();

        this.logger.warn(`Deepgram ${response.status}: ${text}`);

        return null;
      }

      const data = (await response.json()) as DeepgramResponse;
      const channels = data.results?.channels ?? [];
      const agent = channels[0]?.alternatives?.[0]?.transcript?.trim();
      const lead = channels[1]?.alternatives?.[0]?.transcript?.trim();
      const duration = data.metadata?.duration;

      if (!agent && !lead) {
        this.logger.warn('Deepgram returned empty transcript');

        return null;
      }

      // If only one channel (mono), stash it as "full" without speaker labels
      if (channels.length < 2) {
        return { full: agent ?? lead ?? '', durationSeconds: duration };
      }

      const full = this.interleaveByChannel(agent, lead);

      return { full, agent, lead, durationSeconds: duration };
    } catch (error) {
      this.logger.error(
        `Deepgram error: ${error instanceof Error ? error.message : String(error)}`,
      );

      return null;
    }
  }

  // Simple channel-labelled concat. Without per-word timestamps we can't truly
  // interleave — we just prefix each channel's full transcript with its speaker.
  private interleaveByChannel(agent?: string, lead?: string): string {
    const parts: string[] = [];

    if (agent) parts.push(`Agent: ${agent}`);
    if (lead) parts.push(`Lead: ${lead}`);

    return parts.join('\n\n');
  }
}
