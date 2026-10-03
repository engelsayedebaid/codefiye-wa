const CODES: Record<number, string> = {
  400: 'bad_request',
  401: 'unauthorized',
  402: 'payment_required',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  410: 'gone',
  413: 'payload_too_large',
  415: 'unsupported_media_type',
  422: 'validation_failed',
  429: 'rate_limited',
  500: 'internal',
  502: 'bad_gateway',
  503: 'unavailable',
};

/** Stable error code for an HTTP status, when nothing more specific applies. */
export const codeForStatus = (status: number) => CODES[status] ?? (status >= 500 ? 'internal' : 'bad_request');

type Extra = { code?: string; details?: Record<string, unknown>; retryAfter?: number };

/** Thrown from handlers; the error handler renders it as `{ success: false, message, code, errors?, details? }`. */
export class ApiError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  /** Seconds; sent as `Retry-After` and in `details.retryAfter`. */
  readonly retryAfter?: number;

  constructor(
    readonly statusCode: number,
    message: string,
    readonly errors?: Record<string, string[]>,
    extra: Extra = {},
  ) {
    super(message);
    this.name = 'ApiError';
    this.code = extra.code ?? codeForStatus(statusCode);
    this.retryAfter = extra.retryAfter;
    this.details = extra.retryAfter === undefined ? extra.details : { ...extra.details, retryAfter: extra.retryAfter };
  }
}

export const badRequest = (message: string, code?: string) => new ApiError(400, message, undefined, { code });
export const unauthorized = (message = 'Missing or invalid API key', code?: string) => new ApiError(401, message, undefined, { code });
export const paymentRequired = (message: string, code?: string) => new ApiError(402, message, undefined, { code });
export const forbidden = (message: string, code?: string, details?: Record<string, unknown>) => new ApiError(403, message, undefined, { code, details });
export const notFound = (message = 'Not found', code?: string) => new ApiError(404, message, undefined, { code });
export const conflict = (message: string, code?: string, errors?: Record<string, string[]>) => new ApiError(409, message, errors, { code });
export const unprocessable = (message: string, errors?: Record<string, string[]>, extra?: Extra) => new ApiError(422, message, errors, extra);
export const tooMany = (message: string, retryAfter: number, code = 'rate_limited') => new ApiError(429, message, undefined, { code, retryAfter: Math.max(1, Math.ceil(retryAfter)) });
export const unavailable = (message: string, code?: string) => new ApiError(503, message, undefined, { code });
