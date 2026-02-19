/**
 * SOP document factory for tests
 */
export function createSOPContent(sections?: Record<string, string>): string {
  const defaults: Record<string, string> = {
    preflight: "Check service status before proceeding",
    gotchas: "Watch for stale cache issues",
    credentials: "Use op read for secrets",
    ...sections,
  };

  return Object.entries(defaults)
    .map(([key, val]) => `## ${key}\n${val}`)
    .join("\n\n");
}
