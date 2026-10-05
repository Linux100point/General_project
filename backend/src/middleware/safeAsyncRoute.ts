import type { RequestHandler } from 'express';

export function safeAsyncRoute(handler: RequestHandler): RequestHandler {
  return (request, response, next) => {
    void Promise.resolve(handler(request, response, next)).catch((error: unknown) => {
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      console.error('Matching route failed.', { errorName });

      if (response.headersSent) {
        next(error);
        return;
      }

      response.status(500).json({ error: 'Unable to complete the matching request.' });
    });
  };
}