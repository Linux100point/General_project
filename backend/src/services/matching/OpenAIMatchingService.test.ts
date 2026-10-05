import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider, MatchRequestInput, MentorProfile } from '../../types';
import type { MentorProfileExtractor } from './MentorCVExtractionService';
import { MentorCVExtractionService } from './MentorCVExtractionService';
import { MatchingInputError, OpenAIMatchingService } from './OpenAIMatchingService';

const mentors = Array.from({ length: 5 }, (_, index) => ({
  id: `mentor-${index + 1}`,
  name: `Mentor ${index + 1}`,
  cvFileIds: [`cv-${index + 1}`],
}));
const students: MatchRequestInput['students'] = Array.from({ length: 15 }, (_, index) => ({
  id: `S${String(index + 1).padStart(3, '0')}`,
  studentId: `S${String(index + 1).padStart(3, '0')}`,
  name: `Student ${index + 1}`,
  desiredSkills: 'TypeScript',
  topicsForExpertConsultation: 'API design',
  projectOverview: 'Education platform',
  mentorshipSupportNeeds: 'Architecture feedback',
}));

test('extracts profiles with bounded concurrency, sends one cohort to AI, and globally deduplicates final assignments', async () => {
  let activeExtractions = 0;
  let maximumConcurrentExtractions = 0;
  let providerCalls = 0;
  let submittedProfiles: MentorProfile[] = [];
  const extractor: MentorProfileExtractor = {
    async extract(mentor) {
      activeExtractions += 1;
      maximumConcurrentExtractions = Math.max(maximumConcurrentExtractions, activeExtractions);
      await new Promise((resolve) => setTimeout(resolve, 2));
      activeExtractions -= 1;
      return {
        summary: mentor.name,
        skills: [],
        technologies: [],
        domains: [],
        experience: [],
        projectTypes: [],
        expertiseTopics: [],
        evidence: [],
      };
    },
  };
  const provider: AIProvider = {
    async generateRecommendations(input) {
      providerCalls += 1;
      submittedProfiles = input.mentorProfiles ?? [];
      return [
        { mentorId: 'mentor-1', studentId: students[0].id, score: 95, reason: 'First mentor fit.', category: 'selected' },
        { mentorId: 'mentor-2', studentId: students[0].id, score: 90, reason: 'Alternative cross-mentor fit.', category: 'selected' },
      ];
    },
  };
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService(extractor),
    async (mentor) => Buffer.from(`%PDF-${mentor.id}`),
    2,
  );

  const result = await service.run({ mentors, students });

  assert.equal(maximumConcurrentExtractions, 2);
  assert.equal(providerCalls, 1);
  assert.equal(submittedProfiles.length, 5);
  assert.deepEqual(result.finalAssignments.map((assignment) => assignment.studentId), [students[0].id]);
  assert.equal(result.finalAssignments[0].mentorId, 'mentor-1');
});

test('rejects cohorts outside the supported size before reading CVs', async () => {
  let cvReadCount = 0;
  const provider: AIProvider = { async generateRecommendations() { return []; } };
  const extractor: MentorProfileExtractor = {
    async extract() {
      throw new Error('Must not be called.');
    },
  };
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService(extractor),
    async () => {
      cvReadCount += 1;
      return Buffer.alloc(0);
    },
  );
  const tooManyStudents = [
    ...students,
    ...Array.from({ length: 3 }, (_, index) => ({
      ...students[0],
      id: `S${String(index + 16).padStart(3, '0')}`,
      studentId: `S${String(index + 16).padStart(3, '0')}`,
    })),
  ];
  const tooManyMentors = [...mentors, { id: 'mentor-6', name: 'Mentor 6', cvFileIds: ['cv-6'] }];

  await assert.rejects(service.run({ mentors, students: tooManyStudents }), MatchingInputError);
  await assert.rejects(service.run({ mentors: tooManyMentors, students }), MatchingInputError);
  assert.equal(cvReadCount, 0);
});

test('requires an uploaded CV for every mentor in OpenAI mode', async () => {
  const provider: AIProvider = { async generateRecommendations() { return []; } };
  const extractor: MentorProfileExtractor = {
    async extract() {
      throw new Error('Must not be called.');
    },
  };
  const service = new OpenAIMatchingService(provider, new MentorCVExtractionService(extractor), async () => Buffer.alloc(0));

  await assert.rejects(
    service.run({ mentors: [{ ...mentors[0], cvFileIds: [] }], students }),
    /no uploaded CV/,
  );
});
