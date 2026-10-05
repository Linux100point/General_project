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

export function getMatchingSessionPersistenceLogDetails(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error) || error.name !== 'MatchingSessionPersistenceError') {
    return {};
  }

  const persistenceError = error as Error & { operation?: unknown; diagnostics?: unknown };
  const diagnostics = typeof persistenceError.diagnostics === 'object' && persistenceError.diagnostics !== null
    ? persistenceError.diagnostics as Record<string, unknown>
    : {};
  const operation = typeof diagnostics.operation === 'string'
    ? diagnostics.operation
    : typeof persistenceError.operation === 'string' ? persistenceError.operation : undefined;

  return {
    ...(typeof diagnostics.stage === 'string' ? { stage: diagnostics.stage } : {}),
    ...(operation ? { operation } : {}),
    ...(typeof diagnostics.databaseErrorCode === 'string' ? { databaseErrorCode: diagnostics.databaseErrorCode } : {}),
    ...(typeof diagnostics.httpStatus === 'number' ? { httpStatus: diagnostics.httpStatus } : {}),
    ...(typeof diagnostics.causeName === 'string' ? { causeName: diagnostics.causeName } : {}),
    ...(typeof diagnostics.sessionIdExists === 'boolean' ? { sessionIdExists: diagnostics.sessionIdExists } : {}),
    ...(typeof diagnostics.sessionIdIsValidUuid === 'boolean' ? { sessionIdIsValidUuid: diagnostics.sessionIdIsValidUuid } : {}),
    ...(typeof diagnostics.createdByExists === 'boolean' ? { createdByExists: diagnostics.createdByExists } : {}),
    ...(typeof diagnostics.rowFound === 'boolean' || diagnostics.rowFound === null ? { rowFound: diagnostics.rowFound } : {}),
    ...(typeof diagnostics.createdByMatchesAdmin === 'boolean' || diagnostics.createdByMatchesAdmin === null
      ? { createdByMatchesAdmin: diagnostics.createdByMatchesAdmin }
      : {}),
  };
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
    logger('Matching run failed.', {
      stage: fallbackStage,
      errorName: error.name,
      ...getMatchingSessionPersistenceLogDetails(error),
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
