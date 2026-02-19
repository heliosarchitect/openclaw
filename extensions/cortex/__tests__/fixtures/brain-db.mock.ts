/**
 * Mock SQLite DB for testing (in-memory stub)
 */
export function createMockDb() {
  const store = new Map<string, unknown[]>();

  return {
    prepare: (sql: string) => ({
      run: (..._args: unknown[]) => ({ changes: 1 }),
      get: (..._args: unknown[]) => null,
      all: (..._args: unknown[]) => [],
    }),
    exec: (_sql: string) => {},
    close: () => {},
    _store: store,
  };
}
