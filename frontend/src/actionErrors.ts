export class ApiRequestError extends Error {
  constructor(readonly status: number) {
    super(`API request failed with status ${status}.`);
    this.name = 'ApiRequestError';
  }
}

export function getActionErrorMessage(error: unknown): string {
  if (!(error instanceof ApiRequestError)) {
    return 'Could not reach the server. Check your connection and try again.';
  }

  if (error.status === 401) return 'Your session has expired. Sign in again.';
  if (error.status === 403) return 'Your account is not authorized to perform this action.';
  if (error.status === 404) return 'The requested service was not found.';
  if (error.status === 400 || error.status === 422) return 'Check the selected file and required data, then try again.';
  if (error.status >= 500) return 'The server could not complete the request. Try again later.';
  return 'The request failed. Try again.';
}