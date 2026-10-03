export function getApiBaseUrl(): string {
  const configured = (import.meta.env.VITE_API_BASE_URL ?? '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  if (import.meta.env.DEV) {
    return 'http://localhost:3001';
  }

  throw new Error('Missing VITE_API_BASE_URL. Set VITE_API_BASE_URL to the deployed backend URL in production.');
}

export function buildApiUrl(pathname: string): string {
  const baseUrl = getApiBaseUrl();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${baseUrl}${normalizedPath}`;
}
