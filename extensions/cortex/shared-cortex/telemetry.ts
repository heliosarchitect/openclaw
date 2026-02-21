export type RouteType = "subscription" | "api_key";

export interface RunTelemetry {
  run_id: string;
  task_id: string;
  task_type: string;
  selected_model: string;
  fallback_from?: string;
  fallback_to?: string;
  fallback_reason?: string;
  route_type: RouteType;
  tokens_in: number;
  tokens_out: number;
  duration_ms: number;
  success: boolean;
  created_at?: string;
  error_class?: string;
  attempt_count?: number;
}

export interface TelemetryAggregate {
  total_runs: number;
  success_rate: number;
  avg_duration_ms: number;
  total_tokens_in: number;
  total_tokens_out: number;
  fallback_rate: number;
  by_route_type: Record<RouteType, number>;
}

export function aggregateDailyTelemetry(runs: RunTelemetry[]): TelemetryAggregate {
  const totalRuns = runs.length;
  if (totalRuns === 0) {
    return {
      total_runs: 0,
      success_rate: 0,
      avg_duration_ms: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      fallback_rate: 0,
      by_route_type: { subscription: 0, api_key: 0 },
    };
  }

  const successes = runs.filter((r) => r.success).length;
  const fallbackCount = runs.filter((r) => Boolean(r.fallback_to)).length;

  const totalDuration = runs.reduce((sum, r) => sum + r.duration_ms, 0);
  const totalTokensIn = runs.reduce((sum, r) => sum + r.tokens_in, 0);
  const totalTokensOut = runs.reduce((sum, r) => sum + r.tokens_out, 0);

  const byRouteType: Record<RouteType, number> = { subscription: 0, api_key: 0 };
  for (const run of runs) byRouteType[run.route_type] += 1;

  return {
    total_runs: totalRuns,
    success_rate: successes / totalRuns,
    avg_duration_ms: Math.round(totalDuration / totalRuns),
    total_tokens_in: totalTokensIn,
    total_tokens_out: totalTokensOut,
    fallback_rate: fallbackCount / totalRuns,
    by_route_type: byRouteType,
  };
}
