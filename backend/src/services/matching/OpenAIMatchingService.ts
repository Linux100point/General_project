import type { AIProvider, MatchingService, Mentor, MentorProfile } from '../../types';
import { MentorCVExtractionService } from './MentorCVExtractionService';
import { buildMatchingSession } from './MatchingSessionBuilder';
import { MatchingRunStageError, createMatchingRunStageError } from './MatchingRunDiagnostics';
import { MatchingConfigurationError } from './OpenAIProvider';

export type ReadMentorCv = (mentor: Mentor) => Promise<Buffer>;

export type MatchingInputErrorReason = 'mentor-count-out-of-range' | 'student-count-out-of-range';

export class MatchingInputError extends Error {
  constructor(message: string, readonly reason: MatchingInputErrorReason) {
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
      throw new MatchingInputError('OpenAI matching supports one to five mentors per cohort.', 'mentor-count-out-of-range');
    }
    if (input.students.length < 5 || input.students.length > 17) {
      throw new MatchingInputError('OpenAI matching requires five to seventeen students per cohort.', 'student-count-out-of-range');
    }

    const mentorProfiles = await this.extractMentorProfiles(input.mentors);
    let recommendations;
    try {
      recommendations = await this.provider.generateRecommendations({
        ...input,
        mentorProfiles,
      });
    } catch (error) {
      if (error instanceof MatchingRunStageError || error instanceof MatchingConfigurationError) {
        throw error;
      }
      throw createMatchingRunStageError('ai-recommendations', 'AiRecommendationsError');
    }

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
          throw createMatchingRunStageError('mentor-file-record', 'MentorFileRecordError', {
            mentorId: mentor.id,
            fileRecordExists: false,
            storageObjectPathPresent: false,
          });
        }
        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await this.readMentorCv(mentor);
        } catch (error) {
          if (error instanceof MatchingRunStageError || error instanceof MatchingConfigurationError) {
            throw error;
          }
          throw createMatchingRunStageError('mentor-cv-read', 'StorageReadError', {
            mentorId: mentor.id,
          });
        }
        try {
          profiles[mentorIndex] = await this.profileExtractionService.getProfile(mentor, pdfBuffer);
        } catch (error) {
          if (error instanceof MatchingRunStageError || error instanceof MatchingConfigurationError) {
            throw error;
          }
          throw createMatchingRunStageError('mentor-cv-extraction', 'MentorCvExtractionError', {
            mentorId: mentor.id,
          });
        }
      }
    }));

    return profiles;
  }
}
