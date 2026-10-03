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

export function createDefaultMatchingSession(): MatchingSession {
  return {
    id: 'session-demo',
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

  private getDefaultSession(adminUserId: string): MatchingSession {
    const defaultSession = createDefaultMatchingSession();
    return {
      ...defaultSession,
      id: `session-${adminUserId}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
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
      return this.getDefaultSession(adminUserId);
    }

    const { data, error } = await this.client.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message || 'Unable to load the matching session.');
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return this.getDefaultSession(adminUserId);
    }

    const fallback = this.getDefaultSession(adminUserId);
    return this.coerceSession(row.current_result ?? row.original_result ?? null, fallback);
  }

  async saveCurrentSession(adminUserId: string, session: MatchingSession): Promise<MatchingSession> {
    if (!this.client) {
      return session;
    }

    const now = new Date().toISOString();
    const { data: existingRows, error: queryError } = await this.client.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (queryError && queryError.code !== 'PGRST116') {
      throw new Error(queryError.message || 'Unable to save the matching session.');
    }

    const existingRow = Array.isArray(existingRows) ? existingRows[0] : null;
    const row = {
      id: existingRow?.id ?? session.id ?? crypto.randomUUID(),
      created_by: adminUserId,
      original_result: existingRow?.original_result ?? {
        ...session,
        originalRecommendations: session.originalRecommendations,
        currentRecommendations: session.currentRecommendations,
        finalAssignments: session.finalAssignments,
      },
      current_result: session,
      created_at: existingRow?.created_at ?? session.createdAt ?? now,
      updated_at: now,
    };

    if (existingRow) {
      const { error } = await this.client.from(this.tableName).update(row);
      if (error) {
        throw new Error(error.message || 'Unable to update the matching session.');
      }
      return session;
    }

    const { error } = await this.client.from(this.tableName).insert(row);
    if (error) {
      throw new Error(error.message || 'Unable to create the matching session.');
    }

    return session;
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

    const { data, error } = await this.client.from(this.tableName)
      .select('*')
      .eq('created_by', adminUserId)
      .order('updated_at', { ascending: false })
      .limit(1);

    if (error && error.code !== 'PGRST116') {
      throw new Error(error.message || 'Unable to read original recommendations.');
    }

    const row = Array.isArray(data) ? data[0] : null;
    if (!row) {
      return fallback;
    }

    return this.coerceSession(row.original_result ?? row.current_result ?? null, fallback);
  }
}
