import assert from 'node:assert/strict';
import { once } from 'node:events';
import express from 'express';
import test from 'node:test';
import { requireAdminWithForbiddenUnauthenticated, requireRole } from '../../middleware/adminAuth';
import { safeAsyncRoute } from '../../middleware/safeAsyncRoute';
import type { MatchingSession } from '../../types';
import { createMatchingSessionDiagnostics, createMatchingSessionDiagnosticsHandler } from './MatchingSessionDiagnostics';
import { createDefaultMatchingSession, SupabaseMatchingSessionRepository } from './MatchingSessionRepository';

async function withServer(app: express.Express, run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function createDiagnosticSession(): MatchingSession {
  return {
    ...createDefaultMatchingSession(),
    mentors: [
      { id: 'mentor-private-1', name: 'Private Mentor', cvFileIds: ['cv-valid'] },
      { id: 'mentor-private-2', name: 'Mentor Without CV', cvFileIds: [] },
      { id: 'mentor-private-3', name: 'Mentor With Stale CV', cvFileIds: ['cv-missing'] },
    ],
    students: [{
      id: 'student-private',
      studentId: 'S001',
      name: 'Private Student',
      email: 'student@example.invalid',
      desiredSkills: 'Private skill',
      topicsForExpertConsultation: 'Private topic',
      projectOverview: 'Private project',
      mentorshipSupportNeeds: 'Private support request',
    }],
    uploadedMentorFiles: [{
      id: 'cv-valid',
      originalName: 'Private Mentor.pdf',
      filename: 'private-file-name',
      storagePath: 'private/storage/path',
      mimeType: 'application/pdf',
      size: 1,
      uploadedAt: new Date().toISOString(),
      kind: 'mentor-cv',
    }],
  };
}

test('diagnostics report persisted and reconciled counts without returning personal or file data', () => {
  const session = createDiagnosticSession();
  const diagnostic = createMatchingSessionDiagnostics({
    session,
    rowCount: 2,
    selectedUpdatedAt: '2026-10-07T00:00:00.000Z',
  });

  assert.deepEqual(diagnostic, {
    sessionExists: true,
    matchingSessionRowCount: 2,
    selectedSession: {
      id: session.id,
      updatedAt: '2026-10-07T00:00:00.000Z',
    },
    beforeReconciliation: {
      mentorCount: 3,
      studentCount: 1,
      mentorCvReferenceCount: 2,
      mentorsWithZeroCvReferences: 1,
      mentorsWithUnresolvedCvReferences: 1,
    },
    afterReconciliation: {
      mentorCount: 1,
      studentCount: 1,
      mentorsRemoved: 2,
    },
  });
  assert.doesNotMatch(JSON.stringify(diagnostic), /Private|student@example|S001|cv-valid|storage\/path/);
});

test('diagnostics endpoint requires ADMIN and returns safe selected-session metadata', async () => {
  const session = createDiagnosticSession();
  const app = express();
  app.use((req, _res, next) => {
    const role = req.header('x-test-role');
    if (role === 'ADMIN' || role === 'STUDENT' || role === 'MENTOR') {
      (req as express.Request & { user?: { id: string; role: string } }).user = {
        id: 'opaque-admin-id',
        role,
      };
    }
    next();
  });
  app.get(
    '/diagnostics',
    requireRole('ADMIN'),
    safeAsyncRoute(createMatchingSessionDiagnosticsHandler(async (adminUserId) => {
      assert.equal(adminUserId, 'opaque-admin-id');
      return { session, rowCount: 1, selectedUpdatedAt: '2026-10-07T00:00:00.000Z' };
    })),
  );

  await withServer(app, async (baseUrl) => {
    for (const role of ['STUDENT', 'MENTOR']) {
      const denied = await fetch(`${baseUrl}/diagnostics`, { headers: { 'x-test-role': role } });
      assert.equal(denied.status, 403);
    }

    const allowed = await fetch(`${baseUrl}/diagnostics`, { headers: { 'x-test-role': 'ADMIN' } });
    assert.equal(allowed.status, 200);
    const body = await allowed.json() as ReturnType<typeof createMatchingSessionDiagnostics>;
    assert.equal(body.selectedSession?.id, session.id);
    assert.equal(body.beforeReconciliation.mentorCount, 3);
    assert.equal(body.afterReconciliation.mentorCount, 1);
    assert.doesNotMatch(JSON.stringify(body), /Private|student@example|S001|storage\/path/);
  });
});

test('diagnostics endpoint rejects unauthenticated requests with 403', async () => {
  const app = express();
  app.get(
    '/diagnostics',
    requireAdminWithForbiddenUnauthenticated,
    safeAsyncRoute(createMatchingSessionDiagnosticsHandler(async () => {
      throw new Error('must not load without an admin');
    })),
  );

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/diagnostics`);
    assert.equal(response.status, 403);
  });
});

test('diagnostics snapshot preserves the repository selected row when multiple rows exist', async () => {
  const sessionId = 'a6cd5162-9d2f-4da2-a8dd-3055688e42dd';
  const selectedRow = {
    id: sessionId,
    created_by: 'admin-1',
    current_result: { ...createDiagnosticSession(), id: 'legacy-json-session' },
    updated_at: '2026-10-06T12:00:00.000Z',
  };
  let requestedLimit: number | undefined;
  let requestedCountMode: string | undefined;
  const repository = new SupabaseMatchingSessionRepository({
    from: () => ({
      select: (_columns: string, options?: { count?: string }) => {
        requestedCountMode = options?.count;
        return {
        eq: (field: string, adminUserId: string) => {
          assert.equal(field, 'created_by');
          assert.equal(adminUserId, 'admin-1');
          return {
            order: (orderField: string, options: { ascending: boolean }) => {
              assert.equal(orderField, 'updated_at');
              assert.equal(options.ascending, false);
              return {
                limit: async (limit: number) => {
                  requestedLimit = limit;
                  return { data: [selectedRow], error: null, count: 2 };
                },
              };
            },
          };
        },
        };
      },
    }),
  } as never);

  const snapshot = await repository.loadCurrentSessionSnapshot('admin-1', 'session-diagnostic');
  const diagnostic = createMatchingSessionDiagnostics(snapshot);

  assert.equal(requestedLimit, 1);
  assert.equal(requestedCountMode, 'exact');
  assert.equal(diagnostic.matchingSessionRowCount, 2);
  assert.equal(diagnostic.selectedSession?.id, sessionId);
  assert.equal(diagnostic.selectedSession?.updatedAt, selectedRow.updated_at);
  assert.notEqual(diagnostic.selectedSession?.id, 'legacy-json-session');
});
