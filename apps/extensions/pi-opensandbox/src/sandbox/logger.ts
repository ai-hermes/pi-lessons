/**
 * Writes one structured OpenSandbox event to the appropriate console stream.
 *
 * Event names use dot-separated namespaces so logs can be filtered by module
 * and operation. Additional fields should contain identifiers and operation
 * context, while errors should be expanded with `describeOpenSandboxError`.
 *
 * @example
 * logOpenSandboxEvent("info", "sandbox.start.complete", {
 *   sandboxId: "sandbox-123",
 *   startupMode: "created",
 * });
 *
 * // [pi-opensandbox] {"timestamp":"...","component":"pi-extension-opensandbox",
 * // "event":"sandbox.start.complete","sandboxId":"sandbox-123","startupMode":"created"}
 */
export function logOpenSandboxEvent(
  level: "info" | "warn" | "error",
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const payload = {
    timestamp: new Date().toISOString(),
    component: "pi-extension-opensandbox",
    event,
    ...fields,
  };
  const line = `[pi-opensandbox] ${JSON.stringify(payload)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.info(line);
}

/**
 * Converts an unknown thrown value into structured, sanitized log fields.
 *
 * Known transport metadata is retained, nested causes are bounded to three
 * levels, and likely credentials are redacted from messages and stacks.
 *
 * @example
 * const error = Object.assign(
 *   new Error("Request failed: token=secret"),
 *   { statusCode: 401, requestId: "request-123" },
 * );
 *
 * logOpenSandboxEvent("error", "sandbox.start.error", {
 *   sandboxId: "sandbox-123",
 *   ...describeOpenSandboxError(error),
 * });
 *
 * // The emitted errorMessage contains "token=[REDACTED]".
 */
export function describeOpenSandboxError(error: unknown): Record<string, unknown> {
  if (!(error instanceof Error)) return { error: sanitize(String(error)) };
  const details = error as Error & Record<string, unknown>;
  return {
    errorName: error.name,
    errorMessage: sanitize(error.message),
    errorStack: sanitize(error.stack ?? ""),
    ...(typeof details.statusCode === "number" ? { statusCode: details.statusCode } : {}),
    ...(typeof details.requestId === "string" ? { requestId: sanitize(details.requestId) } : {}),
    ...(error.cause === undefined ? {} : { errorCause: describeCause(error.cause, 0) }),
  };
}

// Limit nested causes so recursive or unusually deep error chains cannot make
// a single log event grow without bounds.
function describeCause(error: unknown, depth: number): unknown {
  if (depth >= 3) return "[cause depth limit]";
  if (!(error instanceof Error)) return sanitize(String(error));
  return {
    name: error.name,
    message: sanitize(error.message),
    stack: sanitize(error.stack ?? ""),
    ...(error.cause === undefined ? {} : { cause: describeCause(error.cause, depth + 1) }),
  };
}

// Redact common credential formats before values are written to a console.
// Examples: 
// `apiKey=secret` -> `apiKey=[REDACTED]` and
// `Authorization: Bearer secret` -> `Authorization: Bearer [REDACTED]`.
function sanitize(value: string): string {
  return value
    .replace(
      /(api[-_]?key|password|token)(["']?\s*[=:]\s*["']?)([^\s"',&}]+)/gi,
      "$1$2[REDACTED]",
    )
    .replace(/(Bearer\s+)[^\s]+/gi, "$1[REDACTED]");
}
