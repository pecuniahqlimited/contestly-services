/** An error the API's error handler replies with as { error: code } and this status. */
export const httpError = (statusCode: number, code: string) => Object.assign(new Error(code), { statusCode });
