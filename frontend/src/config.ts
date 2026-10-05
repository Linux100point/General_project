export function resolveApiBaseUrl(configuredValue: string | undefined, isDevelopment: boolean): string {
  const configured = (configuredValue ?? '').trim();
  if (configured) {
    return configured.replace(/\/+$/, '');
  }

  if (isDevelopment) {
    return 'http://localhost:3001';
  }

  throw new Error('Missing VITE_API_BASE_URL. Set VITE_API_BASE_URL to the deployed backend URL in production.');
}

export function getApiBaseUrl(): string {
  return resolveApiBaseUrl(import.meta.env.VITE_API_BASE_URL, import.meta.env.DEV);
}

export function buildApiUrl(pathname: string): string {
  const baseUrl = getApiBaseUrl();
  const normalizedPath = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return `${baseUrl}${normalizedPath}`;
}
