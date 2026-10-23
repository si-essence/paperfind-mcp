export const CONNECTOR_ERROR_CODES = [
  "config",
  "invalid_input",
  "not_found",
  "rate_limited",
  "upstream_unavailable",
  "timeout",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: ConnectorErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function errorPrefix(code: ConnectorErrorCode): string {
  switch (code) {
    case "config":
      return "[config] ";
    case "invalid_input":
      return "[invalid-input] ";
    case "not_found":
      return "[not-found] ";
    case "rate_limited":
      return "[rate-limited] ";
    case "upstream_unavailable":
      return "[upstream] ";
    case "timeout":
      return "[timeout] ";
    default: {
      const neverCode: never = code;
      return neverCode;
    }
  }
}
