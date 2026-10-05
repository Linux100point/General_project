import assert from 'node:assert/strict';
import test from 'node:test';
import { requireRole } from './adminAuth';

test('ADMIN role guard allows admins and rejects student and mentor roles', () => {
  const guard = requireRole('ADMIN');

  for (const role of ['ADMIN', 'STUDENT', 'MENTOR'] as const) {
    let statusCode: number | undefined;
    let body: unknown;
    let nextCalled = false;
    const response = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(value: unknown) {
        body = value;
        return this;
      },
    };

    guard({ user: { role } } as never, response as never, () => { nextCalled = true; });

    if (role === 'ADMIN') {
      assert.equal(nextCalled, true);
      assert.equal(statusCode, undefined);
    } else {
      assert.equal(nextCalled, false);
      assert.equal(statusCode, 403);
      assert.deepEqual(body, {
        error: 'Forbidden',
        message: 'ADMIN role required to access this resource.',
      });
    }
  }
});