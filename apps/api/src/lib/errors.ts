export class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
    readonly errors?: Record<string, string[]>,
  ) {
    super(message);
  }
}

export const badRequest = (m: string) => new HttpError(400, m);
export const unauthorized = (m = 'Invalid or missing API key') => new HttpError(401, m);
export const forbidden = (m: string) => new HttpError(403, m);
export const notFound = (m = 'Not found') => new HttpError(404, m);
export const conflict = (m: string) => new HttpError(409, m);
export const notConnected = (m = 'Session is not connected') => new HttpError(409, m);
export const unavailable = (m: string) => new HttpError(503, m);
