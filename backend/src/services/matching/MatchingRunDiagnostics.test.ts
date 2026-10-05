import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider, MatchRequestInput } from '../../types';
import { MentorCVExtractionService, type MentorProfileExtractor } from './MentorCVExtractionService';
import { MatchingSessionPersistenceError } from './MatchingSessionRepository';
import { OpenAIMatchingService } from './OpenAIMatchingService';
import { MatchingConfigurationError } from './OpenAIProvider';
import { MatchingRunStageError, logMatchingRunFailure, matchingRunFailureResponse } from './MatchingRunDiagnostics';

const input: MatchRequestInput = {
  mentors: [{ id: 'mentor-safe-id', name: 'Mentor', cvFileIds: ['file-safe-id'] }],
  students: Array.from({ length: 5 }, (_, index) => ({
    id: `S00${index + 1}`,
    studentId: `S00${index + 1}`,
    name: `Student ${index + 1}`,
    desiredSkills: 'TypeScript',
    topicsForExpertConsultation: 'APIs',
    projectOverview: 'Project',
    mentorshipSupportNeeds: 'Feedback',
  })),
};

const profileExtractor: MentorProfileExtractor = {
  async extract() {
    return {
      summary: 'Profile', skills: [], technologies: [], domains: [], experience: [], projectTypes: [], expertiseTopics: [], evidence: [],
    };
  },
};

const provider: AIProvider = {
  async generateRecommendations() {
    return [];
  },
};

async function expectStage(action: () => Promise<unknown>, stage: string, errorName: string) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof MatchingRunStageError);
    assert.equal(error.stage, stage);
    assert.equal(error.name, errorName);
    return true;
  });
}

test('classifies CV read failures without retaining the raw failure', async () => {
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService(profileExtractor),
    async () => { throw new Error('storage-secret-value'); },
  );

  await expectStage(() => service.run(input), 'mentor-cv-read', 'StorageReadError');
});

test('classifies CV extraction failures', async () => {
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService({ async extract() { throw new Error('extractor-secret-value'); } }),
    async () => Buffer.from('PDF'),
  );

  await expectStage(() => service.run(input), 'mentor-cv-extraction', 'MentorCvExtractionError');
});

test('classifies recommendation failures', async () => {
  const service = new OpenAIMatchingService(
    { async generateRecommendations() { throw new Error('openai-secret-value'); } },
    new MentorCVExtractionService(profileExtractor),
    async () => Buffer.from('PDF'),
  );

  await expectStage(() => service.run(input), 'ai-recommendations', 'AiRecommendationsError');
});

test('preserves matching configuration failures for the route response', async () => {
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService({ async extract() { throw new MatchingConfigurationError('missing key'); } }),
    async () => Buffer.from('PDF'),
  );

  await assert.rejects(() => service.run(input), MatchingConfigurationError);
});

test('logs persistence failures with a fixed stage and safe error name', () => {
  const logged: unknown[][] = [];
  logMatchingRunFailure(
    new MatchingSessionPersistenceError('update'),
    'session-persistence',
    (...args) => logged.push(args),
  );

  assert.deepEqual(logged, [[
    'Matching run failed.',
    { stage: 'session-persistence', errorName: 'MatchingSessionPersistenceError' },
  ]]);
});

test('diagnostic logs and the client response exclude raw secret text', () => {
  const logged: unknown[][] = [];
  const secret = 'credential-that-must-not-appear';
  logMatchingRunFailure(
    new MatchingRunStageError('mentor-cv-read', 'StorageReadError', {
      storageProvider: 'supabase',
      mentorId: 'mentor-safe-id',
      fileRecordExists: true,
      storageObjectPathPresent: true,
    }),
    'mentor-cv-read',
    (...args) => logged.push(args),
  );

  assert.deepEqual(logged, [[
    'Matching run failed.',
    {
      stage: 'mentor-cv-read',
      errorName: 'StorageReadError',
      storageProvider: 'supabase',
      mentorId: 'mentor-safe-id',
      fileRecordExists: true,
      storageObjectPathPresent: true,
    },
  ]]);
  assert.equal(matchingRunFailureResponse.error, 'Unable to run matching. Check uploaded files and matching configuration.');
  assert.doesNotMatch(JSON.stringify({ logged, response: matchingRunFailureResponse }), new RegExp(secret));
});
