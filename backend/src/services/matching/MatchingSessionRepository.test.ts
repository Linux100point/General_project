import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { safeAsyncRoute } from '../../middleware/safeAsyncRoute';
import type { AIProvider, MatchRequestInput, MatchingSession } from '../../types';
import { MentorCVExtractionService } from './MentorCVExtractionService';
import { MockAIProvider, MockMatchingService } from './MockMatchingService';
import { OpenAIMatchingService } from './OpenAIMatchingService';
import { createDefaultMatchingSession, MatchingSessionPersistenceError, SupabaseMatchingSessionRepository } from './MatchingSessionRepository';
import { logMatchingRunFailure } from './MatchingRunDiagnostics';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function createTestSession(id = 'session-demo'): MatchingSession {
  const timestamp = new Date().toISOString();
  const recommendation = {
    id: 'recommendation-original',
    mentorId: 'mentor-1',
    studentId: 'student-1',
    score: 90,
    reason: 'Original fit',
    category: 'selected' as const,
    source: 'ai' as const,
  };

  return {
    ...createDefaultMatchingSession(),
    id,
    createdAt: timestamp,
    updatedAt: timestamp,
    status: 'draft',
    uploadedMentorFiles: [],
    mentors: [{ id: 'mentor-1', name: 'Mentor One', cvFileIds: ['cv-1'] }],
    students: Array.from({ length: 5 }, (_, index) => ({
      id: `student-${index + 1}`,
      name: `Student ${index + 1}`,
      desiredSkills: 'TypeScript',
      topicsForExpertConsultation: 'API design',
      projectOverview: 'Education platform',
      mentorshipSupportNeeds: 'Architecture feedback',
    })),
    originalRecommendations: [recommendation],
    currentRecommendations: [recommendation],
    finalAssignments: [{ id: 'assignment-original', mentorId: 'mentor-1', studentId: 'student-1', assignedAt: timestamp }],
  };
}

function createUpdateQuery(
  rows: Map<string, Record<string, any>>,
  value: Record<string, any>,
  failure: boolean,
) {
  const filters: Record<string, string> = {};
  const query = {
    eq(field: string, filterValue: string) {
      filters[field] = filterValue;
      return query;
    },
    then(resolve: (value: { error: { code?: string; message: string } | null }) => unknown, reject: (reason: unknown) => unknown) {
      if (failure) {
        return Promise.resolve({ error: { code: '23505', status: 409, name: 'PostgrestError', message: 'database details omitted' } }).then(resolve, reject);
      }

      const matchingRows = [...rows.entries()].filter(([, row]) => Object.entries(filters).every(([field, filterValue]) => row[field] === filterValue));
      for (const [key, row] of matchingRows) {
        rows.set(key, { ...row, ...value });
      }
      return Promise.resolve({ error: null }).then(resolve, reject);
    },
  };
  return query;
}

function createRepositoryHarness(failure: 'select' | 'insert' | 'update' | null = null) {
  const rows = new Map<string, Record<string, any>>();
  const logs: unknown[][] = [];
  const client = {
    from: () => ({
      select: () => ({
        eq: (_field: string, adminId: string) => ({
          order: () => ({
            limit: async () => {
              if (failure === 'select') return { data: null, error: { code: '42501', status: 403, name: 'PostgrestError', message: 'database details omitted' } };
              const matchingRows = [...rows.values()].filter((row) => row.created_by === adminId);
              return { data: matchingRows.slice(0, 1), error: null };
            },
          }),
        }),
      }),
      insert: async (row: Record<string, any>) => {
        if (failure === 'insert') return { data: null, error: { code: '23505', status: 409, name: 'PostgrestError', message: 'database details omitted' } };
        rows.set(String(row.id), { ...row });
        return { data: [row], error: null };
      },
      update: (row: Record<string, any>) => {
        return createUpdateQuery(rows, row, failure === 'update');
      },
    }),
  };

  return {
    repository: new SupabaseMatchingSessionRepository(client as never, 'matching_sessions', (...args) => logs.push(args)),
    rows,
    logs,
  };
}

function createCohort(): MatchRequestInput {
  return {
    mentors: [{ id: 'mentor-1', name: 'Mentor One', cvFileIds: ['cv-1'] }],
    students: Array.from({ length: 5 }, (_, index) => ({
      id: `student-${index + 1}`,
      name: `Student ${index + 1}`,
      desiredSkills: 'TypeScript',
      topicsForExpertConsultation: 'API design',
      projectOverview: 'Education platform',
      mentorshipSupportNeeds: 'Architecture feedback',
    })),
  };
}

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
      update: (value: Record<string, unknown> & { id?: string }) => {
        return createUpdateQuery(rows as Map<string, Record<string, any>>, value, false);
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
  assert.match(persisted.id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  assert.notEqual(persisted.id, session.id);

  const loaded = await repository.loadCurrentSession('admin-1');
  assert.equal(loaded.id, persisted.id);
  assert.equal(loaded.finalAssignments.length, 1);

  const reset = await repository.resetToOriginal('admin-1', session);
  assert.equal(reset.currentRecommendations.length, 1);
  assert.equal(reset.status, 'draft');
});

test('new matching sessions receive valid UUIDs', async () => {
  const session = createDefaultMatchingSession();
  assert.match(session.id, uuidPattern);

  const { repository } = createRepositoryHarness();
  const saved = await repository.saveCurrentSession('admin-1', createTestSession());
  assert.match(saved.id, uuidPattern);
});

test('missing matching session loads an empty UUID-backed default without inserting a row', async () => {
  const { repository, rows } = createRepositoryHarness();
  const loaded = await repository.loadCurrentSession('admin-without-session');

  assert.match(loaded.id, uuidPattern);
  assert.deepEqual(loaded.mentors, []);
  assert.deepEqual(loaded.students, []);
  assert.deepEqual(loaded.currentRecommendations, []);
  assert.deepEqual(loaded.originalRecommendations, []);
  assert.deepEqual(loaded.finalAssignments, []);
  assert.equal(rows.size, 0);
});

test('session loading selects only the authenticated admin and prefers the database UUID over a legacy JSON ID', async () => {
  const { repository, rows } = createRepositoryHarness();
  const sessionId = crypto.randomUUID();
  rows.set(sessionId, {
    id: sessionId,
    created_by: 'admin-1',
    current_result: { ...createTestSession('session-demo'), id: 'session-demo' },
    original_result: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const otherAdminSessionId = crypto.randomUUID();
  rows.set(otherAdminSessionId, {
    id: otherAdminSessionId,
    created_by: 'admin-2',
    current_result: { ...createTestSession('other-admin-session'), mentors: [{ id: 'other', name: 'Other', cvFileIds: [] }] },
    original_result: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const loaded = await repository.loadCurrentSession('admin-1');

  assert.equal(loaded.id, sessionId);
  assert.equal(loaded.mentors[0]?.id, 'mentor-1');
  assert.notEqual(loaded.id, 'session-demo');
});

test('updating a session is scoped to its UUID and admin ownership', async () => {
  const { repository, rows } = createRepositoryHarness();
  const ownId = crypto.randomUUID();
  const otherAdminId = crypto.randomUUID();
  rows.set(ownId, {
    id: ownId,
    created_by: 'admin-1',
    current_result: createTestSession(),
    original_result: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  rows.set(otherAdminId, {
    id: otherAdminId,
    created_by: 'admin-2',
    current_result: { marker: 'must remain untouched' },
    original_result: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  const changedSession = { ...createTestSession(), status: 'final' as const };
  const saved = await repository.saveCurrentSession('admin-1', changedSession);

  assert.equal(saved.id, ownId);
  assert.equal(rows.get(ownId)?.created_by, 'admin-1');
  assert.equal((rows.get(ownId)?.current_result as MatchingSession).status, 'final');
  assert.equal(rows.get(otherAdminId)?.created_by, 'admin-2');
  assert.deepEqual(rows.get(otherAdminId)?.current_result, { marker: 'must remain untouched' });
});

test('session load errors preserve only safe database diagnostics', async () => {
  const { repository, logs } = createRepositoryHarness('select');

  await assert.rejects(
    () => repository.loadCurrentSession('admin-1'),
    (error: unknown) => {
      assert.ok(error instanceof MatchingSessionPersistenceError);
      assert.equal(error.operation, 'load');
      assert.equal(error.diagnostics.operation, 'session-select');
      assert.equal(error.diagnostics.databaseErrorCode, '42501');
      assert.equal(error.diagnostics.httpStatus, 403);
      assert.equal(error.diagnostics.causeName, 'PostgrestError');
      assert.equal(error.diagnostics.sessionIdExists, false);
      assert.equal(error.diagnostics.sessionIdIsValidUuid, false);
      assert.equal(error.diagnostics.createdByExists, true);
      assert.equal(error.diagnostics.rowFound, null);
      assert.equal(error.diagnostics.createdByMatchesAdmin, null);
      assert.doesNotMatch(JSON.stringify(error), /database details omitted/);
      return true;
    },
  );
  assert.deepEqual(logs[0], [
    'Matching session database operation failed.',
    {
      stage: 'session-load',
      operation: 'session-select',
      errorName: 'MatchingSessionPersistenceError',
      causeName: 'PostgrestError',
      sessionIdExists: false,
      sessionIdIsValidUuid: false,
      createdByExists: true,
      rowFound: null,
      createdByMatchesAdmin: null,
      databaseErrorCode: '42501',
      httpStatus: 403,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(logs), /database details omitted/);
});

test('session insert errors preserve safe operation context and database details', async () => {
  const { repository, logs } = createRepositoryHarness('insert');

  await assert.rejects(
    () => repository.saveCurrentSession('admin-1', createTestSession()),
    (error: unknown) => {
      assert.ok(error instanceof MatchingSessionPersistenceError);
      assert.equal(error.operation, 'insert');
      assert.equal(error.diagnostics.operation, 'session-insert');
      assert.equal(error.diagnostics.databaseErrorCode, '23505');
      assert.equal(error.diagnostics.httpStatus, 409);
      assert.equal(error.diagnostics.sessionIdIsValidUuid, true);
      assert.equal(error.diagnostics.createdByExists, true);
      assert.equal(error.diagnostics.rowFound, false);
      assert.equal(error.diagnostics.createdByMatchesAdmin, true);
      return true;
    },
  );
  assert.equal((logs[0]?.[1] as Record<string, unknown>).operation, 'session-insert');
});

test('session update errors preserve the selected UUID and admin ownership context', async () => {
  const { repository, rows, logs } = createRepositoryHarness('update');
  const sessionId = crypto.randomUUID();
  rows.set(sessionId, {
    id: sessionId,
    created_by: 'admin-1',
    current_result: createTestSession(),
    original_result: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  await assert.rejects(
    () => repository.saveCurrentSession('admin-1', createTestSession()),
    (error: unknown) => {
      assert.ok(error instanceof MatchingSessionPersistenceError);
      assert.equal(error.operation, 'update');
      assert.equal(error.diagnostics.operation, 'session-update');
      assert.equal(error.diagnostics.databaseErrorCode, '23505');
      assert.equal(error.diagnostics.httpStatus, 409);
      assert.equal(error.diagnostics.sessionIdExists, true);
      assert.equal(error.diagnostics.sessionIdIsValidUuid, true);
      assert.equal(error.diagnostics.createdByExists, true);
      assert.equal(error.diagnostics.rowFound, true);
      assert.equal(error.diagnostics.createdByMatchesAdmin, true);
      return true;
    },
  );
  assert.equal((logs[0]?.[1] as Record<string, unknown>).operation, 'session-update');
});

test('outer matching-run failure logging preserves repository diagnostics and stage', async () => {
  const { repository } = createRepositoryHarness('select');
  const logs: unknown[][] = [];
  let persistenceError: unknown;
  try {
    await repository.loadCurrentSession('admin-1');
  } catch (error) {
    persistenceError = error;
  }

  logMatchingRunFailure(persistenceError, 'session-load', (...args) => logs.push(args));

  assert.deepEqual(logs, [[
    'Matching run failed.',
    {
      stage: 'session-load',
      errorName: 'MatchingSessionPersistenceError',
      operation: 'session-select',
      databaseErrorCode: '42501',
      httpStatus: 403,
      causeName: 'PostgrestError',
      sessionIdExists: false,
      sessionIdIsValidUuid: false,
      createdByExists: true,
      rowFound: null,
      createdByMatchesAdmin: null,
    },
  ]]);
  assert.doesNotMatch(JSON.stringify(logs), /database details omitted/);
});

test('legacy session-demo is never persisted as matching_sessions.id', async () => {
  const { repository, rows } = createRepositoryHarness();
  const saved = await repository.saveCurrentSession('admin-1', createTestSession('session-demo'));
  const [row] = rows.values();

  assert.notEqual(row.id, 'session-demo');
  assert.match(String(row.id), uuidPattern);
  assert.equal((row.current_result as MatchingSession).id, row.id);
  assert.equal(saved.id, row.id);
});

test('MockMatchingService sessions can be saved with repository-generated UUIDs', async () => {
  const { repository, rows } = createRepositoryHarness();
  const result = await new MockMatchingService(new MockAIProvider()).run(createCohort());
  const saved = await repository.saveCurrentSession('admin-1', result);
  const [row] = rows.values();

  assert.match(saved.id, uuidPattern);
  assert.equal(row.id, saved.id);
  assert.equal((row.current_result as MatchingSession).currentRecommendations.length, result.currentRecommendations.length);
});

test('OpenAI matching results can be saved with a valid UUID without a real API call', async () => {
  const { repository, rows } = createRepositoryHarness();
  const profileFields = {
    summary: 'Test profile',
    skills: ['TypeScript'],
    technologies: ['Node.js'],
    domains: ['Education'],
    experience: [],
    projectTypes: [],
    expertiseTopics: ['API design'],
    evidence: ['Synthetic test profile'],
  };
  const provider: AIProvider = {
    async generateRecommendations(input) {
      return [{
        mentorId: input.mentors[0].id,
        studentId: input.students[0].id,
        score: 90,
        reason: 'Synthetic provider result.',
        category: 'selected',
      }];
    },
  };
  const service = new OpenAIMatchingService(
    provider,
    new MentorCVExtractionService({ async extract() { return profileFields; } }),
    async () => Buffer.from('synthetic PDF bytes'),
  );
  const result = await service.run(createCohort());
  const saved = await repository.saveCurrentSession('admin-1', result);
  const [row] = rows.values();

  assert.match(result.id, uuidPattern);
  assert.match(saved.id, uuidPattern);
  assert.equal(row.id, saved.id);
});

test('saving changes updates the existing session without changing its UUID', async () => {
  const { repository, rows } = createRepositoryHarness();
  const created = await repository.saveCurrentSession('admin-1', createTestSession('session-demo'));
  const changed = {
    ...createTestSession('another-legacy-id'),
    status: 'final' as const,
    finalAssignments: [],
  };
  const saved = await repository.saveCurrentSession('admin-1', changed);
  const [row] = rows.values();

  assert.equal(saved.id, created.id);
  assert.equal(rows.size, 1);
  assert.equal(row.id, created.id);
  assert.equal((row.current_result as MatchingSession).status, 'final');
});

test('reset restores original_result without calling the matching provider', async () => {
  const { repository, rows } = createRepositoryHarness();
  const seed = createTestSession('session-demo');
  seed.originalRecommendations = [];
  seed.currentRecommendations = [];
  seed.finalAssignments = [];
  await repository.saveCurrentSession('admin-1', seed);

  let providerCalls = 0;
  const input = createCohort();
  const service = new OpenAIMatchingService(
    {
      async generateRecommendations(request) {
        providerCalls += 1;
        return [{
          mentorId: request.mentors[0].id,
          studentId: request.students[0].id,
          score: 91,
          reason: 'Synthetic original result.',
          category: 'selected',
        }];
      },
    },
    new MentorCVExtractionService({
      async extract() {
        return { summary: '', skills: [], technologies: [], domains: [], experience: [], projectTypes: [], expertiseTopics: [], evidence: [] };
      },
    }),
    async () => Buffer.from('synthetic PDF bytes'),
  );
  const original = await service.run(input);
  await repository.saveCurrentSession('admin-1', original);
  const changed = { ...original, currentRecommendations: [], finalAssignments: [], status: 'final' as const };
  await repository.saveCurrentSession('admin-1', changed);

  const callsBeforeReset = providerCalls;
  const reset = await repository.resetToOriginal('admin-1', changed);
  const [row] = rows.values();

  assert.deepEqual(reset.currentRecommendations, original.originalRecommendations);
  assert.deepEqual(reset.finalAssignments, original.finalAssignments);
  assert.equal(reset.status, 'draft');
  assert.equal(providerCalls, callsBeforeReset);
  assert.deepEqual((row.original_result as MatchingSession).currentRecommendations, original.currentRecommendations);
});

test('matching persistence failure returns HTTP 500 without terminating the Express process', async () => {
  const { repository } = createRepositoryHarness('insert');
  const app = express();
  app.post('/matching', safeAsyncRoute(async (_request, response) => {
    await repository.saveCurrentSession('admin-1', createTestSession());
    response.json({ success: true });
  }));
  app.get('/health', (_request, response) => response.json({ status: 'ok' }));

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  const originalConsoleError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };

  try {
    const failedResponse = await fetch(`http://127.0.0.1:${address.port}/matching`, { method: 'POST' });
    assert.equal(failedResponse.status, 500);
    assert.deepEqual(await failedResponse.json(), { error: 'Unable to complete the matching request.' });
    assert.deepEqual(logged, [[
      'Matching route failed.',
      {
        errorName: 'MatchingSessionPersistenceError',
        stage: 'session-persistence',
        operation: 'session-insert',
        causeName: 'PostgrestError',
        sessionIdExists: true,
        sessionIdIsValidUuid: true,
        createdByExists: true,
        rowFound: false,
        createdByMatchesAdmin: true,
        databaseErrorCode: '23505',
        httpStatus: 409,
      },
    ]]);

    const healthResponse = await fetch(`http://127.0.0.1:${address.port}/health`);
    assert.equal(healthResponse.status, 200);
  } finally {
    console.error = originalConsoleError;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
