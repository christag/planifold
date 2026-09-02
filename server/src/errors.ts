export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}
export const badRequest = (m: string, code?: string) => new HttpError(400, m, code);
export const unauthorized = (m = "Sign in to continue.") => new HttpError(401, m, "unauthorized");
export const forbidden = (m = "You don't have permission to do that.") => new HttpError(403, m, "forbidden");
export const notFound = (m = "Not found.") => new HttpError(404, m, "not_found");
export const conflict = (m: string) => new HttpError(409, m, "conflict");
