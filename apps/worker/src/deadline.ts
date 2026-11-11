/** A run that's still going after its deadline: the job fails so its worker slot is free for the next run. */
export class DeadlineExceeded extends Error {
  override readonly name = "DeadlineExceeded";
  readonly statusCode = 504;
}

/**
 * Run `run`, or reject with DeadlineExceeded after `ms`. A promise can't be cancelled, so a stuck run is left to
 * finish (or not) on its own; what this guarantees is that the job holding it ends, and the queue moves on.
 */
export function withinDeadline<T>(ms: number, label: string, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new DeadlineExceeded(`${label}: still running after ${ms} ms; given up so the next run isn't held up`)), ms);
  });
  return Promise.race([run(), late]).finally(() => clearTimeout(timer));
}
