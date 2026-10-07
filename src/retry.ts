export type SleepFn = (ms: number) => Promise<void>;

export const sleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function retry<T>(
  attempts: number,
  fn: (attempt: number) => Promise<T>,
  sleepFn: SleepFn = sleep,
  delayMs = 1500,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastError = err;
      if (attempt < attempts) await sleepFn(delayMs);
    }
  }
  throw lastError;
}