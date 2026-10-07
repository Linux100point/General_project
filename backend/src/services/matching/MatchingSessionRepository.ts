import crypto from 'node:crypto';
import { supabaseAdmin } from '../../supabase';
import type { MatchingSession } from '../../types';

export type MatchingSessionRepositoryRow = {
  id: string;
  created_by: string;
  original_result?: Partial<MatchingSession> | null;
  current_result?: Partial<MatchingSession> | null;
  created_at?: string;
  updated_at?: string;
};

export type MatchingSessionLoadSnapshot = {
  session: MatchingSession;
  rowCount: number;
  selectedUpdatedAt: string | null;
};

export type MatchingSessionPersistenceOperation = 'load' | 'save' | 'update' | 'insert' | 'load-original';
export type MatchingSessionDatabaseOperation =
  | 'session-select'
  | 'session-insert'
  | 'session-update'
  | 'session-original-select';

type PersistenceDatabaseError = { code?: string; message?: string; name?: string; status?: number; statusCode?: number } | null;
type PersistenceQueryResult = { data: unknown; error: PersistenceDatabaseError };
type PersistenceMutationResult = { data: unknown; error: PersistenceDatabaseError };
export type MatchingSessionPersistenceDiagnostics = {
  stage: string;
  operation: MatchingSessionDatabaseOperation;
  sessionIdExists: boolean;
  sessionIdIsValidUuid: boolean;
  createdByExists: boolean;
  rowFound: boolean | null;
  createdByMatchesAdmin: boolean | null;
  databaseErrorCode?: string;
  httpStatus?: number;
  causeName?: string;
};

export class MatchingSessionPersistenceError extends Error {
  constructor(
    readonly operation: MatchingSessionPersistenceOperation,
    readonly diagnostics: MatchingSessionPersistenceDiagnostics,
  ) {
    super('Unable to persist or load the matching session.');
    this.name = 'MatchingSessionPersistenceError';
  }
}

type PersistenceDiagnosticContext = Omit<MatchingSessionPersistenceDiagnostics, 'databaseErrorCode' | 'httpStatus' | 'causeName'>;
type MatchingSessionDiagnosticLogger = (message: string, details: Record<string, unknown>) => void;

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const safeErrorCodePattern = /^[A-Za-z0-9_.-]{1,40}$/;
const safeErrorNamePattern = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/;

function createPersistenceError(
  legacyOperation: MatchingSessionPersistenceOperation,
  error: unknown,
  context: PersistenceDiagnosticContext,
  logger: MatchingSessionDiagnosticLogger,
): MatchingSessionPersistenceError {
  const cause = typeof error === 'object' && error !== null
    ? error as { code?: unknown; name?: unknown; status?: unknown; statusCode?: unknown }
    : {};
  const causeName = typeof cause.name === 'string' && safeErrorNamePattern.test(cause.name)
    ? cause.name
    : error instanceof Error && safeErrorNamePattern.test(error.name) ? error.name : 'UnknownError';
  const errorCode = typeof cause.code === 'string' && safeErrorCodePattern.test(cause.code)
    ? cause.code
    : undefined;
  const status = typeof cause.status === 'number' ? cause.status : cause.statusCode;
  const diagnostics: MatchingSessionPersistenceDiagnostics = {
    ...context,
    ...(errorCode ? { databaseErrorCode: errorCode } : {}),
    ...(typeof status === 'number' && status >= 100 && status <= 599 ? { httpStatus: status } : {}),
    causeName,
  };
  const persistenceError = new MatchingSessionPersistenceError(legacyOperation, diagnostics);

  logger('Matching session database operation failed.', {
    stage: diagnostics.stage,
    operation: diagnostics.operation,
    errorName: persistenceError.name,
    causeName: diagnostics.causeName,
    sessionIdExists: diagnostics.sessionIdExists,
    sessionIdIsValidUuid: diagnostics.sessionIdIsValidUuid,
    createdByExists: diagnostics.createdByExists,
    rowFound: diagnostics.rowFound,
    createdByMatchesAdmin: diagnostics.createdByMatchesAdmin,
    ...(diagnostics.databaseErrorCode ? { databaseErrorCode: diagnostics.databaseErrorCode } : {}),
    ...(diagnostics.httpStatus !== undefined ? { httpStatus: diagnostics.httpStatus } : {}),
  });
  return persistenceError;
}

async function runPersistence<T>(
  operation: MatchingSessionPersistenceOperation,
  context: PersistenceDiagnosticContext,
  action: () => Promise<T>,
  logger: MatchingSessionDiagnosticLogger,
): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof MatchingSessionPersistenceError) {
      throw error;
    }
    throw createPersistenceError(operation, error, context, logger);
  }
}

export function createDefaultMatchingSession(): MatchingSession {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft',
    uploadedMentorFiles: [],
    uploadedStudentFile: undefined,
    mentors: [],
    students: [],
    originalRecommendations: [],
    currentRecommendations: [],
    finalAssignments: [],
  };
}

export class SupabaseMatchingSessionRepository {
  constructor(
    private readonly client: { from: (table: string) => any } | null = supabaseAdmin,
    private readonly tableName = 'matching_sessions',
    private readonly diagnosticLogger: MatchingSessionDiagnosticLogger = console.error,
  ) {}

  private getDefaultSession(): MatchingSession {
    return createDefaultMatchingSession();
  }

  private coerceSession(value: Partial<MatchingSession> | null | undefined, fallback: MatchingSession): MatchingSession {
    const status = value?.status === 'draft' || value?.status === 'final' ? value.status : fallback.status;

    return {
      ...fallback,
      ...(value ?? {}),
      status,
      uploadedMentorFiles: value?.uploadedMentorFiles ?? fallback.uploadedMentorFiles ?? [],
      uploadedStudentFile: value?.uploadedStudentFile ?? fallback.uploadedStudentFile,
      mentors: value?.mentors ?? fallback.mentors ?? [],
      students: value?.students ?? fallback.students ?? [],
      originalRecommendations: value?.originalRecommendations ?? fallback.originalRecommendations ?? [],
      currentRecommendations: value?.currentRecommendations ?? fallback.currentRecommendations ?? [],
      finalAssignments: value?.finalAssignments ?? fallback.finalAssignments ?? [],
    };
  }

  async loadCurrentSession(adminUserId: string, stage = 'session-load'): Promise<MatchingSession> {
    const snapshot = await this.loadCurrentSessionData(adminUserId, stage, false);
    return snapshot.session;
  }

  async loadCurrentSessionSnapshot(adminUserId: string, stage = 'session-load'): Promise<MatchingSessionLoadSnapshot> {
    return this.loadCurrentSessionData(adminUserId, stage, true);
  }

  private async loadCurrentSessionData(
    adminUserId: string,
    stage: string,
    includeExactRowCount: boolean,
  ): Promise<MatchingSessionLoadSnapshot> {
    if (!this.client) {
      return {
        session: this.getDefaultSession(),
        rowCount: 0,
        selectedUpdatedAt: null,
      };
    }

    const context: PersistenceDiagnosticContext = {
      stage,
      operation: 'session-select',
      sessionIdExists: false,
      sessionIdIsValidUuid: false,
      createdByExists: Boolean(adminUserId),
      rowFound: null,
      createdByMatchesAdmin: null,
    };
    const { data, error, count } = await runPersistence<PersistenceQueryResult & { count?: number | null }>('load', context, () => this.client!.from(this.tableName)
      .select('*', includeExactRowCount ? { count: 'exact' } : undefined)
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1), this.diagnosticLogger);

    if (error && error.code !== 'PGRST116') {
      throw createPersistenceError('load', error, context, this.diagnosticLogger);
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return {
        session: this.getDefaultSession(),
        rowCount: count ?? 0,
        selectedUpdatedAt: null,
      };
    }

    const fallback = this.getDefaultSession();
    return {
      session: {
        ...this.coerceSession(row.current_result ?? row.original_result ?? null, fallback),
        id: row.id,
      },
      rowCount: count ?? (Array.isArray(data) ? data.length : 0),
      selectedUpdatedAt: typeof row.updated_at === 'string' ? row.updated_at : null,
    };
  }

  async saveCurrentSession(adminUserId: string, session: MatchingSession, stage = 'session-persistence'): Promise<MatchingSession> {
    if (!this.client) {
      return { ...session, id: crypto.randomUUID() };
    }

    const now = new Date().toISOString();
    const selectContext: PersistenceDiagnosticContext = {
      stage,
      operation: 'session-select',
      sessionIdExists: Boolean(session.id),
      sessionIdIsValidUuid: uuidPattern.test(session.id),
      createdByExists: Boolean(adminUserId),
      rowFound: null,
      createdByMatchesAdmin: null,
    };
    const { data: existingRows, error: queryError } = await runPersistence<PersistenceQueryResult>('save', selectContext, () => this.client!.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1), this.diagnosticLogger);

    if (queryError && queryError.code !== 'PGRST116') {
      throw createPersistenceError('save', queryError, selectContext, this.diagnosticLogger);
    }

    const existingRow = Array.isArray(existingRows) ? existingRows[0] : null;
    const persistedSession = {
      ...session,
      id: existingRow?.id ?? crypto.randomUUID(),
    };
    const existingOriginalResult = existingRow?.original_result as Partial<MatchingSession> | null | undefined;
    const hasOriginalRecommendations = Boolean(existingOriginalResult?.originalRecommendations?.length);
    const originalResult = existingRow && hasOriginalRecommendations
      ? existingOriginalResult
      : {
        ...persistedSession,
        originalRecommendations: persistedSession.originalRecommendations,
        currentRecommendations: persistedSession.currentRecommendations,
        finalAssignments: persistedSession.finalAssignments,
      };
    const row = {
      id: persistedSession.id,
      created_by: adminUserId,
      original_result: originalResult,
      current_result: persistedSession,
      created_at: existingRow?.created_at ?? session.createdAt ?? now,
      updated_at: now,
    };

    if (existingRow) {
      const updateContext: PersistenceDiagnosticContext = {
        stage,
        operation: 'session-update',
        sessionIdExists: Boolean(persistedSession.id),
        sessionIdIsValidUuid: uuidPattern.test(persistedSession.id),
        createdByExists: Boolean(existingRow.created_by),
        rowFound: true,
        createdByMatchesAdmin: existingRow.created_by === adminUserId,
      };
      const { data, error } = await runPersistence<PersistenceMutationResult>('update', updateContext, () => this.client!.from(this.tableName)
        .update(row)
        .eq('id', persistedSession.id)
        .eq('created_by', adminUserId)
        .select('id, created_by'), this.diagnosticLogger);
      if (error) {
        throw createPersistenceError('update', error, updateContext, this.diagnosticLogger);
      }
      const updatedRows = Array.isArray(data) ? data : data ? [data] : [];
      const updatedRow = updatedRows.find((updated: { id?: unknown; created_by?: unknown }) => (
        updated.id === persistedSession.id && updated.created_by === adminUserId
      ));
      if (!updatedRow) {
        throw createPersistenceError(
          'update',
          Object.assign(new Error('Matching session update affected no row.'), { name: 'MatchingSessionUpdateNotAppliedError' }),
          { ...updateContext, rowFound: false, createdByMatchesAdmin: false },
          this.diagnosticLogger,
        );
      }
      return persistedSession;
    }

    const insertContext: PersistenceDiagnosticContext = {
      stage,
      operation: 'session-insert',
      sessionIdExists: Boolean(persistedSession.id),
      sessionIdIsValidUuid: uuidPattern.test(persistedSession.id),
      createdByExists: Boolean(adminUserId),
      rowFound: false,
      createdByMatchesAdmin: true,
    };
    const { data, error } = await runPersistence<PersistenceMutationResult>('insert', insertContext, () => this.client!.from(this.tableName)
      .insert(row)
      .select('id, created_by'), this.diagnosticLogger);
    if (error) {
      throw createPersistenceError('insert', error, insertContext, this.diagnosticLogger);
    }
    const insertedRows = Array.isArray(data) ? data : data ? [data] : [];
    const insertedRow = insertedRows.find((inserted: { id?: unknown; created_by?: unknown }) => (
      inserted.id === persistedSession.id && inserted.created_by === adminUserId
    ));
    if (!insertedRow) {
      throw createPersistenceError(
        'insert',
        Object.assign(new Error('Matching session insert returned no row.'), { name: 'MatchingSessionInsertNotAppliedError' }),
        { ...insertContext, rowFound: false, createdByMatchesAdmin: false },
        this.diagnosticLogger,
      );
    }

    return persistedSession;
  }

  async resetToOriginal(adminUserId: string, session: MatchingSession): Promise<MatchingSession> {
    const original = await this.loadOriginalResult(adminUserId, session);
    const restored: MatchingSession = {
      ...session,
      currentRecommendations: original.currentRecommendations ?? original.originalRecommendations ?? session.currentRecommendations,
      finalAssignments: original.finalAssignments ?? session.finalAssignments,
      status: 'draft',
      updatedAt: new Date().toISOString(),
    };

    return this.saveCurrentSession(adminUserId, restored);
  }

  private async loadOriginalResult(adminUserId: string, fallback: MatchingSession): Promise<MatchingSession> {
    if (!this.client) {
      return fallback;
    }

    const context: PersistenceDiagnosticContext = {
      stage: 'session-load',
      operation: 'session-original-select',
      sessionIdExists: Boolean(fallback.id),
      sessionIdIsValidUuid: uuidPattern.test(fallback.id),
      createdByExists: Boolean(adminUserId),
      rowFound: null,
      createdByMatchesAdmin: null,
    };
    const { data, error } = await runPersistence<PersistenceQueryResult>('load-original', context, () => this.client!.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1), this.diagnosticLogger);

    if (error && error.code !== 'PGRST116') {
      throw createPersistenceError('load-original', error, context, this.diagnosticLogger);
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return fallback;
    }

    return this.coerceSession(row.original_result ?? row.current_result ?? null, fallback);
  }
}
