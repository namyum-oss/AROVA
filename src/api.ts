const configuredApiUrl = import.meta.env.VITE_API_URL?.trim().replace(/\/+$/, '');
const apiBaseUrl = configuredApiUrl || (import.meta.env.PROD ? 'https://arova-8ev9.onrender.com' : '');

export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!path.startsWith('/api/')) return fetch(path, init);
  return fetch(`${apiBaseUrl}${path}`, { ...init, credentials: 'include' });
}

export function apiWebSocketUrl(path: string): string {
  const url = new URL(path, apiBaseUrl || location.origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.toString();
}
