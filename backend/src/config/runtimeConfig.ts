export function isProductionEnvironment(): boolean {
  return process.env.NODE_ENV === 'production';
}

export function getFrontendOrigin(): string {
  const configured = process.env.FRONTEND_URL?.trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  if (!isProductionEnvironment()) {
    return 'http://localhost:5173';
  }

  throw new Error('Missing FRONTEND_URL. Set FRONTEND_URL to the deployed frontend origin in production.');
}

export function getSupabaseInviteRedirectUrl(): string {
  const configured = process.env.SUPABASE_INVITE_REDIRECT_URL?.trim();
  if (configured) {
    return configured;
  }

  if (!isProductionEnvironment()) {
    return 'http://localhost:5173/?set-password=1';
  }

  throw new Error('Missing SUPABASE_INVITE_REDIRECT_URL. Set it to the deployed password reset URL in production.');
}
