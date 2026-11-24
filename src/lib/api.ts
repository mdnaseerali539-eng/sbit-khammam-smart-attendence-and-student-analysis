// In-memory bearer token holder (never stored in localStorage)
let currentBearerToken: string | null = null;

export function setAuthToken(token: string | null) {
  currentBearerToken = token;
}

export function getAuthToken(): string | null {
  return currentBearerToken;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  details?: Record<string, unknown>;

  constructor(message: string, status: number, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit & { skipAuth?: boolean } = {}
): Promise<T> {
  const { skipAuth, ...fetchOptions } = options;
  const headers = new Headers(fetchOptions.headers || {});
  if (!headers.has('Content-Type') && fetchOptions.body && !(fetchOptions.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  if (!skipAuth && currentBearerToken) {
    headers.set('Authorization', `Bearer ${currentBearerToken}`);
  }

  const res = await fetch(path, {
    ...fetchOptions,
    headers,
  });

  const contentType = res.headers.get('content-type') || '';
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    let code: string | undefined;
    let details: Record<string, unknown> | undefined;
    if (contentType.includes('application/json')) {
      const errData = await res.json().catch(() => ({}));
      if (errData.error) message = errData.error;
      if (errData.code) code = errData.code;
      details = errData;
    }
    throw new ApiError(message, res.status, code, details);
  }

  if (contentType.includes('application/json')) {
    return (await res.json()) as T;
  }
  return (await res.text()) as unknown as T;
}

export async function downloadAuthenticatedBlob(path: string, filename: string): Promise<void> {
  const headers = new Headers();
  if (currentBearerToken) {
    headers.set('Authorization', `Bearer ${currentBearerToken}`);
  }
  const res = await fetch(path, { headers });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'Export failed' }));
    throw new Error(err.error || 'Failed to download file');
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
