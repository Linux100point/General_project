import assert from 'node:assert/strict';
import test from 'node:test';
import type OpenAI from 'openai';
import type { MatchRequestInput, MentorProfile } from '../../types';
import { MatchingConfigurationError, OpenAIProvider, validateMatchingRecommendations } from './OpenAIProvider';

const profiles: MentorProfile[] = [{
  mentorId: 'mentor-a',
  name: 'Mentor A',
  summary: 'Backend engineering mentor',
  skills: ['APIs'],
  technologies: ['TypeScript'],
  domains: ['education'],
  experience: ['API design'],
  projectTypes: ['web apps'],
  expertiseTopics: ['architecture'],
  evidence: ['Designed backend APIs.'],
}];

const students: MatchRequestInput['students'] = Array.from({ length: 5 }, (_, index) => ({
  id: `S00${index + 1}`,
  studentId: `S00${index + 1}`,
  name: `Student ${index + 1}`,
  desiredSkills: 'TypeScript',
  topicsForExpertConsultation: 'API design',
  projectOverview: 'Build an education service',
  mentorshipSupportNeeds: 'Architecture feedback',
}));

function validPayload() {
  return {
    mentors: [{
      mentorId: 'mentor-a',
      selected: students.slice(0, 3).map((student, index) => ({ studentId: student.id, score: 95 - index, reason: 'Relevant experience supports this project.' })),
      alternatives: students.slice(3).map((student, index) => ({ studentId: student.id, score: 80 - index, reason: 'Related expertise provides an alternative fit.' })),
    }],
  };
}

function makeProvider(responseText: string, onRequest?: (request: unknown) => void): OpenAIProvider {
  const client = {
    responses: {
      create: async (request: unknown) => {
        onRequest?.(request);
        return { status: 'completed', output: [], output_text: responseText };
      },
    },
  } as unknown as Pick<OpenAI, 'responses'>;
  return new OpenAIProvider(client, 'gpt-6-astra');
}

test('reports missing backend credentials without making a network request', async () => {
  const provider = new OpenAIProvider(null, 'gpt-6-astra');
  await assert.rejects(
    provider.generateRecommendations({
      mentors: [{ id: 'mentor-a', name: 'Mentor A', cvFileIds: ['cv-a'] }],
      mentorProfiles: profiles,
      students,
    }),
    MatchingConfigurationError,
  );
});

test('uses store:false and strict schema constrained to input IDs', async () => {
  let request: any;
  await makeProvider(JSON.stringify(validPayload()), (value) => { request = value; }).generateRecommendations({
    mentors: [{ id: 'mentor-a', name: 'Mentor A', cvFileIds: ['cv-a'] }],
    mentorProfiles: profiles,
    students,
  });

  assert.equal(request.store, false);
  assert.equal(request.model, 'gpt-6-astra');
  assert.equal(request.reasoning.effort, 'high');
  assert.equal(request.text.format.strict, true);
  assert.deepEqual(request.text.format.schema.properties.mentors.items.properties.mentorId.enum, ['mentor-a']);
  assert.deepEqual(request.text.format.schema.properties.mentors.items.properties.selected.items.properties.studentId.enum, students.map((student) => student.id));
});

test('validates and converts exactly three selected and two alternative recommendations', async () => {
  const result = await makeProvider(JSON.stringify(validPayload())).generateRecommendations({
    mentors: [{ id: 'mentor-a', name: 'Mentor A', cvFileIds: ['cv-a'] }],
    mentorProfiles: profiles,
    students,
  });

  assert.equal(result.length, 5);
  assert.equal(result.filter((item) => item.category === 'selected').length, 3);
  assert.equal(result.filter((item) => item.category === 'alternative').length, 2);
  assert.ok(result.every((item) => item.mentorId === 'mentor-a' && item.reason.length > 0));
});

test('rejects invented IDs, duplicate students, overlap, invalid scores, and wrong counts', () => {
  const payload = validPayload();
  assert.throws(() => validateMatchingRecommendations({ ...payload, mentors: [{ ...payload.mentors[0], mentorId: 'invented' }] }, profiles, students), /unknown mentor ID/);

  const duplicateSelected = validPayload();
  duplicateSelected.mentors[0].selected[1].studentId = duplicateSelected.mentors[0].selected[0].studentId;
  assert.throws(() => validateMatchingRecommendations(duplicateSelected, profiles, students), /duplicate selected/);

  const overlapping = validPayload();
  overlapping.mentors[0].alternatives[0].studentId = overlapping.mentors[0].selected[0].studentId;
  assert.throws(() => validateMatchingRecommendations(overlapping, profiles, students), /overlapping/);

  const invalidScore = validPayload();
  invalidScore.mentors[0].selected[0].score = 101;
  assert.throws(() => validateMatchingRecommendations(invalidScore, profiles, students));

  const wrongCount = validPayload();
  wrongCount.mentors[0].selected.pop();
  assert.throws(() => validateMatchingRecommendations(wrongCount, profiles, students));

  const unknownStudent = validPayload();
  unknownStudent.mentors[0].selected[0].studentId = 'invented-student';
  assert.throws(() => validateMatchingRecommendations(unknownStudent, profiles, students), /unknown student ID/);

  const duplicateMentor = validPayload();
  duplicateMentor.mentors.push(duplicateMentor.mentors[0]);
  assert.throws(() => validateMatchingRecommendations(duplicateMentor, profiles, students));

  const unexpectedProperty = validPayload();
  (unexpectedProperty.mentors[0].selected[0] as typeof unexpectedProperty.mentors[0]['selected'][number] & { rawCv?: string }).rawCv = 'must not be accepted';
  assert.throws(() => validateMatchingRecommendations(unexpectedProperty, profiles, students));
});