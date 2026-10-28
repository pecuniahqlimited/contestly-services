/** An error the API's error handler replies with as { error: code } and this status, plus `details` when given. */
export const httpError = (statusCode: number, code: string, details?: unknown) => Object.assign(new Error(code), { statusCode, details });
