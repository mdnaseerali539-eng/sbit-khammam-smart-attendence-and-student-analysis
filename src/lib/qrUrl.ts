export function getDefaultQrBaseUrl(): string {
  if (typeof window === 'undefined') return '';
  return window.location.origin;
}

export function isPrivateDevOrigin(): boolean {
  if (typeof window === 'undefined') return false;
  return window.location.origin.includes('//ais-dev-');
}
