import type { Request, RequestHandler } from 'express';
import type { MatchingSession } from '../../types';
import { reconcileMentorCvSession } from './MentorCvSession';
import type { MatchingSessionLoadSnapshot } from './MatchingSessionRepository';

type AuthenticatedAdminRequest = Request & {
  user?: {
    id: string;
  };
};

export type MatchingSessionDiagnostics = {
  sessionExists: boolean;
  matchingSessionRowCount: number;
  selectedSession: {
    id: string;
    updatedAt: string | null;
  } | null;
  beforeReconciliation: {
    mentorCount: number;
    studentCount: number;
    mentorCvReferenceCount: number;
    mentorsWithZeroCvReferences: number;
    mentorsWithUnresolvedCvReferences: number;
  };
  afterReconciliation: {
    mentorCount: number;
    studentCount: number;
    mentorsRemoved: number;
  };
};

type SessionSnapshotLoader = (adminUserId: string) => Promise<MatchingSessionLoadSnapshot>;

function countItems(value: unknown): number {
  return Array.isArray(value) ? value.length : 0;
}

export function createMatchingSessionDiagnostics(snapshot: MatchingSessionLoadSnapshot): MatchingSessionDiagnostics {
  const session = snapshot.session as MatchingSession;
  const mentors = Array.isArray(session.mentors) ? session.mentors : [];
  const students = Array.isArray(session.students) ? session.students : [];
  const mentorFiles = Array.isArray(session.uploadedMentorFiles)
    ? session.uploadedMentorFiles.filter((file) => file?.kind === 'mentor-cv')
    : [];
  const mentorFileIds = new Set(mentorFiles.map((file) => file.id));
  let mentorCvReferenceCount = 0;
  let mentorsWithZeroCvReferences = 0;
  let mentorsWithUnresolvedCvReferences = 0;

  for (const mentor of mentors) {
    const cvFileIds = Array.isArray(mentor?.cvFileIds) ? mentor.cvFileIds : [];
    mentorCvReferenceCount += cvFileIds.length;
    if (cvFileIds.length === 0) {
      mentorsWithZeroCvReferences += 1;
    } else if (cvFileIds.some((fileId) => !mentorFileIds.has(fileId))) {
      mentorsWithUnresolvedCvReferences += 1;
    }
  }

  const reconciled = reconcileMentorCvSession(session);
  const reconciledMentorCount = countItems(reconciled.mentors);

  return {
    sessionExists: snapshot.rowCount > 0,
    matchingSessionRowCount: snapshot.rowCount,
    selectedSession: snapshot.rowCount > 0
      ? { id: session.id, updatedAt: snapshot.selectedUpdatedAt }
      : null,
    beforeReconciliation: {
      mentorCount: mentors.length,
      studentCount: students.length,
      mentorCvReferenceCount,
      mentorsWithZeroCvReferences,
      mentorsWithUnresolvedCvReferences,
    },
    afterReconciliation: {
      mentorCount: reconciledMentorCount,
      studentCount: countItems(reconciled.students),
      mentorsRemoved: mentors.length - reconciledMentorCount,
    },
  };
}

export function createMatchingSessionDiagnosticsHandler(loadSnapshot: SessionSnapshotLoader): RequestHandler {
  return async (req, res) => {
    const adminUserId = (req as AuthenticatedAdminRequest).user?.id;
    if (!adminUserId) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }

    const snapshot = await loadSnapshot(adminUserId);
    res.json(createMatchingSessionDiagnostics(snapshot));
  };
}
