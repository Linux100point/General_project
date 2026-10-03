import assert from 'node:assert/strict';
import test from 'node:test';
import type { Mentor } from '../../types';
import {
  MentorCVExtractionService,
  MentorProfileFieldsSchema,
  type MentorProfileExtractor,
  type MentorProfileFields,
} from './MentorCVExtractionService';

const mentor: Mentor = { id: 'mentor-abc', name: 'Mentor A', cvFileIds: ['cv-1'] };

function buildFields(summary = 'Backend and cloud engineering'): MentorProfileFields {
  return {
    summary,
    skills: ['system design'],
    technologies: ['TypeScript'],
    domains: ['education'],
    experience: ['API development'],
    projectTypes: ['web applications'],
    expertiseTopics: ['backend architecture'],
    evidence: ['Built REST APIs with TypeScript.'],
  };
}

test('validates a normalized mentor profile field set', () => {
  assert.equal(MentorProfileFieldsSchema.safeParse(buildFields()).success, true);
  assert.equal(MentorProfileFieldsSchema.safeParse({ ...buildFields(), unrequested: 'field' }).success, false);
});

test('reuses cached CV profile for the same mentor ID and content hash', async () => {
  let extractionCount = 0;
  const extractor: MentorProfileExtractor = {
    async extract() {
      extractionCount += 1;
      return buildFields();
    },
  };
  const service = new MentorCVExtractionService(extractor);
  const pdf = Buffer.from('%PDF-test-cv');

  const firstProfile = await service.getProfile(mentor, pdf);
  const secondProfile = await service.getProfile(mentor, pdf);

  assert.equal(extractionCount, 1);
  assert.equal(firstProfile.mentorId, mentor.id);
  assert.equal(firstProfile.name, mentor.name);
  assert.deepEqual(secondProfile, firstProfile);
});

test('re-extracts when the PDF content hash changes', async () => {
  let extractionCount = 0;
  const extractor: MentorProfileExtractor = {
    async extract() {
      extractionCount += 1;
      return buildFields(`CV version ${extractionCount}`);
    },
  };
  const service = new MentorCVExtractionService(extractor);

  await service.getProfile(mentor, Buffer.from('%PDF-version-one'));
  const changedProfile = await service.getProfile(mentor, Buffer.from('%PDF-version-two'));

  assert.equal(extractionCount, 2);
  assert.equal(changedProfile.summary, 'CV version 2');
});