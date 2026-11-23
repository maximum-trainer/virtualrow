/**
 * The virtualrow Worker's public base URL (#37, #421), baked at build time
 * from `VITE_API_BASE_URL`. `null` keeps every Worker-backed feature off.
 */
export function readApiBaseUrl(): string | null {
  try {
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
    const value = env?.VITE_API_BASE_URL;
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
