export async function jsonBody<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    return {} as T;
  }
}

export function hasSameStringItems(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  if (values.size !== right.length) return false;
  return right.every((value) => values.has(value));
}
