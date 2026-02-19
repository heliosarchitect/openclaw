/**
 * Safe env variable reset utility for tests
 */
export function withEnv(
  overrides: Record<string, string | undefined>,
  fn: () => void | Promise<void>,
) {
  const originals: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    originals[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    const result = fn();
    if (result instanceof Promise) {
      return result.finally(() => {
        for (const [key, val] of Object.entries(originals)) {
          if (val === undefined) delete process.env[key];
          else process.env[key] = val;
        }
      });
    }
  } finally {
    for (const [key, val] of Object.entries(originals)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
  }
}
