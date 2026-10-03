import assert from 'node:assert/strict';
import test from 'node:test';
import { SupabaseMatchingSessionRepository } from './MatchingSessionRepository';

test('matching session repository creates and updates a session', async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const repository = new SupabaseMatchingSessionRepository({
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => ({
            limit: async () => {
              const latest = Array.from(rows.values()).sort((a: Record<string, unknown>, b: Record<string, unknown>) => Number(new Date(String((b.updated_at ?? 0) as string))) - Number(new Date(String((a.updated_at ?? 0) as string))))[0];
              return { data: latest ? [latest] : [], error: null };
            },
          }),
        }),
      }),
      insert: async (value: Record<string, unknown> & { id?: string }) => {
        rows.set(String(value.id), { ...value });
        return { data: [value], error: null };
      },
      update: async (value: Record<string, unknown> & { id?: string }) => {
        const key = String(value.id);
        const row = rows.get(key) ?? {};
        rows.set(key, { ...row, ...value });
        return { data: [rows.get(key)], error: null };
      },
    }),
  } as never, 'matching_sessions');

  const session = {
    id: 'session-1',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    uploadedMentorFiles: [],
    mentors: [],
    students: [],
    originalRecommendations: [{
      id: 'rec-1',
      mentorId: 'mentor-1',
      studentId: 'student-1',
      score: 92,
      reason: 'Strong match',
      category: 'selected',
      source: 'ai',
    }],
    currentRecommendations: [{
      id: 'rec-1',
      mentorId: 'mentor-1',
      studentId: 'student-1',
      score: 92,
      reason: 'Strong match',
      category: 'selected',
      source: 'ai',
    }],
    finalAssignments: [{
      id: 'final-1',
      mentorId: 'mentor-1',
      studentId: 'student-1',
      assignedAt: new Date().toISOString(),
    }],
  } as any;

  const persisted = await repository.saveCurrentSession('admin-1', session);
  assert.equal(persisted.id, 'session-1');

  const loaded = await repository.loadCurrentSession('admin-1');
  assert.equal(loaded.id, 'session-1');
  assert.equal(loaded.finalAssignments.length, 1);

  const reset = await repository.resetToOriginal('admin-1', session);
  assert.equal(reset.currentRecommendations.length, 1);
  assert.equal(reset.status, 'draft');
});
