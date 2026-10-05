export type MatchingRunStage =
  | 'session-load'
  | 'mentor-file-record'
  | 'mentor-cv-read'
  | 'mentor-cv-extraction'
  | 'ai-recommendations'
  | 'session-persistence'
  | 'response';

export type MatchingRunDiagnosticDetails = {
  storageProvider?: 'supabase' | 'local';
  mentorId?: string;
  fileRecordExists?: boolean;
  storageObjectPathPresent?: boolean;
};

export class MatchingRunStageError extends Error {
  constructor(
    readonly stage: MatchingRunStage,
    errorName: string,
    readonly details?: MatchingRunDiagnosticDetails,
  ) {
    super(errorName);
    this.name = errorName;
  }
}

export function createMatchingRunStageError(
  stage: MatchingRunStage,
  errorName: string,
  details?: MatchingRunDiagnosticDetails,
): MatchingRunStageError {
  return new MatchingRunStageError(stage, errorName, details);
}

export function logMatchingRunFailure(
  error: unknown,
  fallbackStage: MatchingRunStage,
  logger: (message: string, details: Record<string, unknown>) => void = console.error,
): void {
  if (error instanceof MatchingRunStageError) {
    logger('Matching run failed.', {
      stage: error.stage,
      errorName: error.name,
      ...error.details,
    });
    return;
  }

  if (error instanceof Error && error.name === 'MatchingSessionPersistenceError') {
    const persistenceError = error as Error & { operation?: unknown; details?: unknown };
    const details = typeof persistenceError.details === 'object' && persistenceError.details !== null
      ? persistenceError.details as { databaseErrorCode?: unknown; httpStatus?: unknown; causeName?: unknown }
      : {};
    logger('Matching run failed.', {
      stage: fallbackStage,
      errorName: error.name,
      ...(typeof persistenceError.operation === 'string' ? { operation: persistenceError.operation } : {}),
      ...(typeof details.databaseErrorCode === 'string' ? { databaseErrorCode: details.databaseErrorCode } : {}),
      ...(typeof details.httpStatus === 'number' ? { httpStatus: details.httpStatus } : {}),
      ...(typeof details.causeName === 'string' ? { causeName: details.causeName } : {}),
    });
    return;
  }

  logger('Matching run failed.', {
    stage: fallbackStage,
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
}

export const matchingRunFailureResponse = {
  error: 'Unable to run matching. Check uploaded files and matching configuration.',
};
