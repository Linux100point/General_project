import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { zodTextFormat } from 'openai/helpers/zod';
import { z } from 'zod';
import type { Mentor, MentorProfile } from '../../types';
import { MatchingConfigurationError } from './OpenAIProvider';

export const MentorProfileFieldsSchema = z.object({
  summary: z.string(),
  skills: z.array(z.string()),
  technologies: z.array(z.string()),
  domains: z.array(z.string()),
  experience: z.array(z.string()),
  projectTypes: z.array(z.string()),
  expertiseTopics: z.array(z.string()),
  evidence: z.array(z.string()),
}).strict();

export type MentorProfileFields = z.infer<typeof MentorProfileFieldsSchema>;

export interface MentorProfileExtractor {
  extract(mentor: Mentor, pdfBuffer: Buffer): Promise<MentorProfileFields>;
}

export interface MentorProfileCache {
  get(mentorId: string, contentHash: string): MentorProfileFields | undefined;
  set(mentorId: string, contentHash: string, profile: MentorProfileFields): void;
}

export class InMemoryMentorProfileCache implements MentorProfileCache {
  private readonly profiles = new Map<string, MentorProfileFields>();

  get(mentorId: string, contentHash: string): MentorProfileFields | undefined {
    const profile = this.profiles.get(this.getKey(mentorId, contentHash));
    return profile ? this.clone(profile) : undefined;
  }

  set(mentorId: string, contentHash: string, profile: MentorProfileFields): void {
    this.profiles.set(this.getKey(mentorId, contentHash), this.clone(profile));
  }

  private getKey(mentorId: string, contentHash: string): string {
    return `${mentorId}:${contentHash}`;
  }

  private clone(profile: MentorProfileFields): MentorProfileFields {
    return {
      ...profile,
      skills: [...profile.skills],
      technologies: [...profile.technologies],
      domains: [...profile.domains],
      experience: [...profile.experience],
      projectTypes: [...profile.projectTypes],
      expertiseTopics: [...profile.expertiseTopics],
      evidence: [...profile.evidence],
    };
  }
}

export class MentorCVExtractionService {
  constructor(
    private readonly extractor: MentorProfileExtractor,
    private readonly cache: MentorProfileCache = new InMemoryMentorProfileCache(),
  ) {}

  async getProfile(mentor: Mentor, pdfBuffer: Buffer): Promise<MentorProfile> {
    const contentHash = createHash('sha256').update(pdfBuffer).digest('hex');
    const cachedProfile = this.cache.get(mentor.id, contentHash);
    const fields = cachedProfile ?? await this.extractor.extract(mentor, pdfBuffer);
    const validatedFields = MentorProfileFieldsSchema.parse(fields);

    if (!cachedProfile) {
      this.cache.set(mentor.id, contentHash, validatedFields);
    }

    return {
      mentorId: mentor.id,
      name: mentor.name,
      ...validatedFields,
    };
  }
}

export class OpenAIMentorProfileExtractor implements MentorProfileExtractor {
  constructor(
    private readonly client: Pick<OpenAI, 'responses'> | null,
    private readonly model: string,
  ) {}

  async extract(mentor: Mentor, pdfBuffer: Buffer): Promise<MentorProfileFields> {
    if (!this.client) {
      throw new MatchingConfigurationError('OpenAI CV extraction requires OPENAI_API_KEY on the backend.');
    }

    const response = await this.client.responses.parse({
      model: this.model,
      store: false,
      reasoning: { effort: 'low' },
      input: [
        {
          role: 'system',
          content: 'You are extracting structured professional information from a mentor CV for a university mentor-student matching system. Use ONLY information supported by the CV. Do not invent technologies, skills, years of experience, domains, projects, or expertise. Normalize equivalent technology names when reasonable. Keep the extracted profile compact but informative. The mentor ID and display name are provided by the backend and must not be inferred from the document. Return only the requested structured data.',
        },
        {
          role: 'user',
          content: [
            { type: 'input_text', text: `Backend mentor ID: ${mentor.id}. Backend mentor display name: ${mentor.name}. Extract the CV profile fields.` },
            {
              type: 'input_file',
              filename: `${mentor.id}.pdf`,
              file_data: `data:application/pdf;base64,${pdfBuffer.toString('base64')}`,
              detail: 'low',
            },
          ],
        },
      ],
      text: { format: zodTextFormat(MentorProfileFieldsSchema, 'mentor_profile') },
    });

    if (response.status !== 'completed' || !response.output_parsed) {
      throw new Error('Mentor CV extraction returned no complete structured profile.');
    }

    return MentorProfileFieldsSchema.parse(response.output_parsed);
  }
}