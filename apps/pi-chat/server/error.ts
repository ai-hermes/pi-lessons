export function errorResponse(error: unknown, status = 500) {
  return {
    error: error instanceof Error ? error.message : String(error),
    status,
  };
}
