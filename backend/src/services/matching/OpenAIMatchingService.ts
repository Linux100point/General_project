import type { AIProvider, MatchingService, Mentor, MentorProfile } from '../../types';
import { MentorCVExtractionService } from './MentorCVExtractionService';
import { buildMatchingSession } from './MatchingSessionBuilder';

export type ReadMentorCv = (mentor: Mentor) => Promise<Buffer>;

export class MatchingInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MatchingInputError';
  }
}

export class OpenAIMatchingService implements MatchingService {
  constructor(
    private readonly provider: AIProvider,
    private readonly profileExtractionService: MentorCVExtractionService,
    private readonly readMentorCv: ReadMentorCv,
    private readonly maxConcurrentExtractions = 2,
  ) {
    if (!Number.isInteger(maxConcurrentExtractions) || maxConcurrentExtractions < 1) {
      throw new Error('CV extraction concurrency must be a positive integer.');
    }
  }

  async run(input: Parameters<MatchingService['run']>[0]) {
    if (input.mentors.length < 1 || input.mentors.length > 5) {
      throw new MatchingInputError('OpenAI matching supports one to five mentors per cohort.');
    }
    if (input.students.length < 5 || input.students.length > 17) {
      throw new MatchingInputError('OpenAI matching requires five to seventeen students per cohort.');
    }

    const mentorProfiles = await this.extractMentorProfiles(input.mentors);
    const recommendations = await this.provider.generateRecommendations({
      ...input,
      mentorProfiles,
    });

    return buildMatchingSession({ ...input, mentorProfiles }, recommendations);
  }

  private async extractMentorProfiles(mentors: Mentor[]): Promise<MentorProfile[]> {
    const profiles = new Array<MentorProfile>(mentors.length);
    let nextIndex = 0;
    const workerCount = Math.min(this.maxConcurrentExtractions, mentors.length);

    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (true) {
        const mentorIndex = nextIndex;
        nextIndex += 1;
        if (mentorIndex >= mentors.length) {
          return;
        }

        const mentor = mentors[mentorIndex];
        if (!mentor.cvFileIds.length) {
          throw new Error(`Mentor "${mentor.id}" has no uploaded CV.`);
        }
        const pdfBuffer = await this.readMentorCv(mentor);
        profiles[mentorIndex] = await this.profileExtractionService.getProfile(mentor, pdfBuffer);
      }
    }));

    return profiles;
  }
}