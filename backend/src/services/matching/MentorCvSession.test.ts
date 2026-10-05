import assert from 'node:assert/strict';
import test from 'node:test';
import type { AIProvider, MatchingSession, UploadedFileRecord } from '../../types';
import { SupabaseFileStorage } from '../storage/LocalFileStorage';
import { MentorCVExtractionService } from './MentorCVExtractionService';
import { applyUploadedMentorCvFiles, reconcileMentorCvSession, resolveMentorCvFile } from './MentorCvSession';
import { OpenAIMatchingService } from './OpenAIMatchingService';
import { createDefaultMatchingSession, SupabaseMatchingSessionRepository } from './MatchingSessionRepository';

function createSession(): MatchingSession {
  return {
    ...createDefaultMatchingSession(),
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
}

function createRecord(id: string): UploadedFileRecord {
  return {
    id,
    originalName: 'mentor.pdf',
    filename: `mentors/${id}.pdf`,
    storagePath: `mentors/${id}.pdf`,
    mimeType: 'application/pdf',
    size: 3,
    uploadedAt: new Date().toISOString(),
    kind: 'mentor-cv',
  };
}

function createRepository() {
  const rows = new Map<string, Record<string, unknown>>();
  return new SupabaseMatchingSessionRepository({
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: async () => ({ data: [...rows.values()], error: null }) }) }) }),
      insert: (row: Record<string, unknown>) => ({
        select: async () => {
          rows.set(String(row.id), row);
          return { data: [{ id: row.id, created_by: row.created_by }], error: null };
        },
      }),
      update: async (row: Record<string, unknown>) => {
        rows.set(String(row.id), row);
        return { error: null };
      },
    }),
  } as never);
}

test('legacy seed shape reconciles to five students and zero demo mentors', () => {
  const session = createSession();
  session.mentors = Array.from({ length: 3 }, (_, index) => ({
    id: `mentor-${index + 1}`,
    name: `Demo mentor ${index + 1}`,
    cvFileIds: [],
  }));

  const reconciled = reconcileMentorCvSession(session);

  assert.deepEqual(reconciled.mentors, []);
  assert.deepEqual(reconciled.uploadedMentorFiles, []);
  assert.equal(reconciled.students.length, 5);
});

test('persists uploaded mentor metadata and resolves the same mentor ID during matching', async () => {
  const record = createRecord('file-record-1');
  const uploaded = applyUploadedMentorCvFiles(createSession(), [record], [{ id: 'mentor-durable', name: 'Durable mentor' }]);
  const repository = createRepository();
  await repository.saveCurrentSession('admin-1', uploaded);
  const loaded = await repository.loadCurrentSession('admin-1');
  const mentor = loaded.mentors[0];
  const resolved = resolveMentorCvFile(loaded, mentor);

  assert.equal(mentor.id, 'mentor-durable');
  assert.equal(mentor.cvFileIds[0], record.id);
  assert.equal(resolved?.id, record.id);
  assert.equal(resolved?.storagePath, record.storagePath);

  const storage = new SupabaseFileStorage({
    async upload() { return { data: null, error: null }; },
    async download(_bucket: string, objectPath: string) {
      assert.equal(objectPath, record.storagePath);
      return { data: new Blob([Buffer.from('PDF')]), error: null };
    },
  } as never, 'project-files');
  const provider: AIProvider = { async generateRecommendations() { return []; } };
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService({
      async extract() {
        return { summary: '', skills: [], technologies: [], domains: [], experience: [], projectTypes: [], expertiseTopics: [], evidence: [] };
      },
    }),
    async (matchingMentor) => storage.readFile(resolveMentorCvFile(loaded, matchingMentor)!),
  );

  await service.run({ mentors: loaded.mentors, students: loaded.students });
});

test('replacing a mentor CV removes stale metadata and keeps the latest file reference', () => {
  const first = createRecord('file-record-old');
  const replacement = createRecord('file-record-new');
  const firstUpload = applyUploadedMentorCvFiles(createSession(), [first], [{ id: 'mentor-durable', name: 'Durable mentor' }]);
  const replaced = applyUploadedMentorCvFiles(firstUpload, [replacement], [{ id: 'mentor-durable', name: 'Durable mentor' }]);

  assert.deepEqual(replaced.mentors[0].cvFileIds, [replacement.id]);
  assert.deepEqual(replaced.uploadedMentorFiles.map((file) => file.id), [replacement.id]);
  assert.equal(resolveMentorCvFile(replaced, replaced.mentors[0])?.id, replacement.id);
});
