export function safeJsonParse<T>(data: string | object | null | undefined, fallback: T): T {
  if (data === null || data === undefined) {
    return fallback;
  }

  if (typeof data === 'object') {
    return data as unknown as T;
  }

  if (typeof data === 'string') {
    try {
      const parsed = JSON.parse(data);
      return parsed as T;
    } catch (error) {
      console.warn('Failed to parse JSON string:', error);
      return fallback;
    }
  }

  return fallback;
}
