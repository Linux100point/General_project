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

export type MatchingSessionPersistenceOperation = 'load' | 'save' | 'update' | 'insert' | 'load-original';

type PersistenceDatabaseError = { code?: string; message?: string } | null;
type PersistenceQueryResult = { data: unknown; error: PersistenceDatabaseError };
type PersistenceMutationResult = { error: PersistenceDatabaseError };

export class MatchingSessionPersistenceError extends Error {
  constructor(readonly operation: MatchingSessionPersistenceOperation) {
    super('Unable to persist or load the matching session.');
    this.name = 'MatchingSessionPersistenceError';
  }
}

async function runPersistence<T>(
  operation: MatchingSessionPersistenceOperation,
  action: () => Promise<T>,
): Promise<T> {
  try {
    return await action();
  } catch {
    throw new MatchingSessionPersistenceError(operation);
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

  async loadCurrentSession(adminUserId: string): Promise<MatchingSession> {
    if (!this.client) {
      return this.getDefaultSession();
    }

    const { data, error } = await runPersistence<PersistenceQueryResult>('load', () => this.client!.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1));

    if (error && error.code !== 'PGRST116') {
      throw new MatchingSessionPersistenceError('load');
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return this.getDefaultSession();
    }

    const fallback = this.getDefaultSession();
    return {
      ...this.coerceSession(row.current_result ?? row.original_result ?? null, fallback),
      id: row.id,
    };
  }

  async saveCurrentSession(adminUserId: string, session: MatchingSession): Promise<MatchingSession> {
    if (!this.client) {
      return { ...session, id: crypto.randomUUID() };
    }

    const now = new Date().toISOString();
    const { data: existingRows, error: queryError } = await runPersistence<PersistenceQueryResult>('save', () => this.client!.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1));

    if (queryError && queryError.code !== 'PGRST116') {
      throw new MatchingSessionPersistenceError('save');
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
      const { error } = await runPersistence<PersistenceMutationResult>('update', () => this.client!.from(this.tableName).update(row));
      if (error) {
        throw new MatchingSessionPersistenceError('update');
      }
      return persistedSession;
    }

    const { error } = await runPersistence<PersistenceMutationResult>('insert', () => this.client!.from(this.tableName).insert(row));
    if (error) {
      throw new MatchingSessionPersistenceError('insert');
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

    const { data, error } = await runPersistence<PersistenceQueryResult>('load-original', () => this.client!.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1));

    if (error && error.code !== 'PGRST116') {
      throw new MatchingSessionPersistenceError('load-original');
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return fallback;
    }

    return this.coerceSession(row.original_result ?? row.current_result ?? null, fallback);
  }
}
