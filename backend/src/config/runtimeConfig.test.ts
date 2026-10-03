import assert from 'node:assert/strict';
import test from 'node:test';
import { getFrontendOrigin, getSupabaseInviteRedirectUrl, isProductionEnvironment } from './runtimeConfig';

test('development fallback works for frontend origin and invite redirect', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousInviteRedirect = process.env.SUPABASE_INVITE_REDIRECT_URL;

  delete process.env.NODE_ENV;
  delete process.env.FRONTEND_URL;
  delete process.env.SUPABASE_INVITE_REDIRECT_URL;

  try {
    assert.equal(isProductionEnvironment(), false);
    assert.equal(getFrontendOrigin(), 'http://localhost:5173');
    assert.equal(getSupabaseInviteRedirectUrl(), 'http://localhost:5173/?set-password=1');
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousInviteRedirect === undefined) delete process.env.SUPABASE_INVITE_REDIRECT_URL; else process.env.SUPABASE_INVITE_REDIRECT_URL = previousInviteRedirect;
  }
});

test('production missing config fails safely', () => {
  const previousNodeEnv = process.env.NODE_ENV;
  const previousFrontendUrl = process.env.FRONTEND_URL;
  const previousInviteRedirect = process.env.SUPABASE_INVITE_REDIRECT_URL;

  process.env.NODE_ENV = 'production';
  delete process.env.FRONTEND_URL;
  delete process.env.SUPABASE_INVITE_REDIRECT_URL;

  try {
    assert.throws(() => getFrontendOrigin(), /Missing FRONTEND_URL/);
    assert.throws(() => getSupabaseInviteRedirectUrl(), /Missing SUPABASE_INVITE_REDIRECT_URL/);
  } finally {
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousNodeEnv;
    if (previousFrontendUrl === undefined) delete process.env.FRONTEND_URL; else process.env.FRONTEND_URL = previousFrontendUrl;
    if (previousInviteRedirect === undefined) delete process.env.SUPABASE_INVITE_REDIRECT_URL; else process.env.SUPABASE_INVITE_REDIRECT_URL = previousInviteRedirect;
  }
});
