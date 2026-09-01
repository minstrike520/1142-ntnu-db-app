"use client";

import React, { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useChat } from "@/context/ChatContext";
import {
  ApiError,
  getActiveAccessToken,
  getAdminHealth,
  getAdminLogs,
  getAdminMetrics,
  getAdminSlowQueries,
  type AdminLogEntry,
  type AdminMetricsResponse,
  type AdminSlowQuery,
} from "@/lib/api";
import { useTranslation } from "@/hooks/useTranslation";
import { useActiveAccessToken } from "@/hooks/useActiveAccessToken";
import { Button } from "@/components/ui/Button";

const ADMIN_POLL_INTERVAL_MS = 30_000;
const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx", "other"] as const;
type AccessState = "checking" | "allowed" | "forbidden" | "error";
type VerifiedAccess = { token: string; sessionKey: string };

type MonitoringState = {
  metrics: AdminMetricsResponse | null;
  logs: AdminLogEntry[];
  slowQueries: AdminSlowQuery[];
  lastUpdated: number | null;
};

const emptyMonitoringState: MonitoringState = {
  metrics: null,
  logs: [],
  slowQueries: [],
  lastUpdated: null,
};

const formatBytes = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = -1;
  do {
    value /= 1024;
    unitIndex += 1;
  } while (value >= 1024 && unitIndex < units.length - 1);
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
};

const formatTimestamp = (timestamp: number): string => {
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString();
};

const formatNumber = (value: number): string => value.toLocaleString();

export default function AdminPage() {
  const router = useRouter();
  const { isAuthenticated, isMounted, user } = useChat();
  const { t } = useTranslation();
  const [access, setAccess] = useState<AccessState>("checking");
  const [verifiedAccess, setVerifiedAccess] = useState<VerifiedAccess | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringState>(emptyMonitoringState);
  const activeToken = useActiveAccessToken();
  const sessionKey = user.userId ?? "anonymous";

  useEffect(() => {
    if (!isMounted) return;

    if (!isAuthenticated || !activeToken) {
      router.replace("/login?redirect=/admin");
      return;
    }

    let cancelled = false;

    void getAdminHealth(activeToken)
      .then(() => {
        if (!cancelled) {
          setVerifiedAccess({ token: activeToken, sessionKey });
          setAccess("allowed");
        }
      })
      .catch((requestError: unknown) => {
        if (cancelled) return;
        if (requestError instanceof ApiError && requestError.status === 403) {
          setVerifiedAccess(null);
          setAccess("forbidden");
          return;
        }
        if (requestError instanceof ApiError && requestError.status === 401) {
          setVerifiedAccess(null);
          router.replace("/login?redirect=/admin");
          return;
        }
        setVerifiedAccess(null);
        console.error("Failed to verify admin access:", requestError);
        setError(t("adminPage.accessError"));
        setAccess("error");
      });

    return () => {
      cancelled = true;
    };
  }, [activeToken, isAuthenticated, isMounted, router, sessionKey, t]);

  useEffect(() => {
    if (
      access !== "allowed" ||
      !activeToken ||
      verifiedAccess === null ||
      verifiedAccess.token !== activeToken ||
      verifiedAccess.sessionKey !== sessionKey
    ) return;

    let cancelled = false;
    let timer: number | undefined;
    let inFlight = false;

    const scheduleNextPoll = () => {
      if (!cancelled) {
        timer = window.setTimeout(() => {
          timer = undefined;
          void loadMonitoringData();
        }, ADMIN_POLL_INTERVAL_MS);
      }
    };

    const loadMonitoringData = async () => {
      if (cancelled || inFlight) return;

      const token = getActiveAccessToken();
      if (!token) {
        cancelled = true;
        router.replace("/login?redirect=/admin");
        return;
      }

      inFlight = true;
      let shouldContinuePolling = true;
      try {
        const [metricsResult, logsResult, slowQueriesResult] = await Promise.allSettled([
          getAdminMetrics(token),
          getAdminLogs(token),
          getAdminSlowQueries(token),
        ]);
        if (cancelled) return;
        if (getActiveAccessToken() !== token) {
          shouldContinuePolling = false;
          return;
        }

        const results = [metricsResult, logsResult, slowQueriesResult];
        const rejectedResults = results.filter(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        const authorizationError = rejectedResults.find(
          (result) => result.reason instanceof ApiError && (result.reason.status === 401 || result.reason.status === 403),
        );
        if (authorizationError) throw authorizationError.reason;
        if (rejectedResults[0]) throw rejectedResults[0].reason;

        if (metricsResult.status !== "fulfilled" || logsResult.status !== "fulfilled" || slowQueriesResult.status !== "fulfilled") {
          return;
        }
        setMonitoring({
          metrics: metricsResult.value,
          logs: logsResult.value.entries,
          slowQueries: slowQueriesResult.value.queries,
          lastUpdated: metricsResult.value.at,
        });
        setError(null);
      } catch (requestError: unknown) {
        if (cancelled) return;
        if (requestError instanceof ApiError && requestError.status === 403) {
          shouldContinuePolling = false;
          setAccess("forbidden");
          return;
        }
        if (requestError instanceof ApiError && requestError.status === 401) {
          shouldContinuePolling = false;
          setAccess("checking");
          router.replace("/login?redirect=/admin");
          return;
        }
        console.error("Failed to load admin monitoring data:", requestError);
        setError(t("adminPage.loadError"));
      } finally {
        inFlight = false;
        if (shouldContinuePolling) scheduleNextPoll();
      }
    };

    void loadMonitoringData();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [access, activeToken, router, sessionKey, t, verifiedAccess]);

  const isVerifiedForCurrentSession =
    access === "allowed" &&
    activeToken !== null &&
    verifiedAccess !== null &&
    verifiedAccess.token === activeToken &&
    verifiedAccess.sessionKey === sessionKey;

  if (access === "checking" || (access === "allowed" && !isVerifiedForCurrentSession)) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-text-muted" data-testid="admin-loading">
        {t("common.loading")}
      </div>
    );
  }

  if (access === "forbidden" || access === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="admin-forbidden">
        <section className="w-full max-w-lg border border-border-primary bg-surface-card p-8 text-center">
          <h1 className="text-xl font-bold text-foreground">
            {access === "forbidden" ? t("adminPage.forbiddenTitle") : t("adminPage.errorTitle")}
          </h1>
          <p className="mt-3 text-sm text-text-muted">
            {access === "forbidden" ? t("adminPage.forbiddenDescription") : error}
          </p>
          <Button className="mt-6" variant="secondary" onClick={() => router.push("/")}>
            {t("adminPage.backToChat")}
          </Button>
        </section>
      </div>
    );
  }

  return (
    <main className="h-full min-w-0 flex-1 overflow-y-auto bg-background p-4 text-foreground sm:p-6" data-testid="admin-page">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="flex flex-wrap items-end justify-between gap-3 border-b border-border-primary pb-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">{t("adminPage.title")}</h1>
            <p className="mt-1 text-sm text-text-muted">{t("adminPage.subtitle")}</p>
          </div>
          <div className="text-right text-xs text-text-muted">
            <p>{t("adminPage.polling", { seconds: ADMIN_POLL_INTERVAL_MS / 1000 })}</p>
            {monitoring.lastUpdated !== null && (
              <p className="mt-1 font-mono">{t("adminPage.lastUpdated", { time: formatTimestamp(monitoring.lastUpdated) })}</p>
            )}
          </div>
        </header>

        {error && (
          <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
            {error}
          </div>
        )}

        <MetricsSection metrics={monitoring.metrics} t={t} />
        <SlowQueriesSection queries={monitoring.slowQueries} t={t} />
        <LogsSection entries={monitoring.logs} t={t} />
      </div>
    </main>
  );
}

function MetricsSection({
  metrics,
  t,
}: {
  metrics: AdminMetricsResponse | null;
  t: (key: string, replacements?: Record<string, string | number>) => string;
}) {
  const statusValues = metrics ? STATUS_CLASSES.map((status) => [status, metrics.requests.statusClasses[status]] as const) : [];
  const maxStatusCount = Math.max(1, ...statusValues.map(([, count]) => count));
  const latency = metrics?.requests.latency;

  return (
    <section className="space-y-4" data-testid="admin-metrics">
      <SectionHeading title={t("adminPage.metricsTitle")} description={t("adminPage.metricsDescription")} />
      {!metrics ? (
        <LoadingPanel label={t("common.loading")} />
      ) : (
        <div className="grid gap-4 xl:grid-cols-[1.2fr_1fr]">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <MetricCard label={t("adminPage.totalRequests")} value={formatNumber(metrics.requests.totalRequests)} />
            <MetricCard label={t("adminPage.uptime")} value={`${metrics.process.uptimeSeconds.toFixed(1)} s`} />
            <MetricCard label={t("adminPage.cpu")} value={metrics.process.cpu.percent === null ? "—" : `${metrics.process.cpu.percent.toFixed(1)}%`} />
            <MetricCard label={t("adminPage.memoryRss")} value={formatBytes(metrics.process.memory.rssBytes)} />
          </div>
          <div className="border border-border-primary bg-surface-card p-4">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">{t("adminPage.statusCodes")}</h3>
            <div className="mt-4 space-y-3">
              {statusValues.map(([status, count]) => (
                <div key={status} className="grid grid-cols-[3rem_1fr_3rem] items-center gap-2 text-xs">
                  <span className="font-mono text-text-muted">{status}</span>
                  <div className="h-2 rounded-full bg-surface-muted">
                    <div className="h-2 rounded-full bg-primary" style={{ width: `${(count / maxStatusCount) * 100}%` }} />
                  </div>
                  <span className="text-right font-mono text-foreground">{count}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="border border-border-primary bg-surface-card p-4 xl:col-span-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">{t("adminPage.latency")}</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              {latency && (
                <>
                  <MetricCard label={t("adminPage.latencySamples")} value={formatNumber(latency.count)} />
                  <MetricCard label={t("adminPage.average") } value={`${latency.avgMs} ms`} />
                  <MetricCard label={t("adminPage.p50")} value={`${latency.p50Ms} ms`} />
                  <MetricCard label={t("adminPage.p95")} value={`${latency.p95Ms} ms`} />
                  <MetricCard label={t("adminPage.p99")} value={`${latency.p99Ms} ms`} />
                  <MetricCard label={t("adminPage.maximum")} value={`${latency.maxMs} ms`} />
                </>
              )}
            </div>
          </div>
          <div className="border border-border-primary bg-surface-card p-4 xl:col-span-2">
            <h3 className="text-xs font-bold uppercase tracking-wider text-text-muted">{t("adminPage.memoryDetails")}</h3>
            <div className="mt-4 grid gap-3 sm:grid-cols-3">
              <MetricCard label={t("adminPage.heapUsed")} value={formatBytes(metrics.process.memory.heapUsedBytes)} />
              <MetricCard label={t("adminPage.heapTotal")} value={formatBytes(metrics.process.memory.heapTotalBytes)} />
              <MetricCard label={t("adminPage.externalMemory")} value={formatBytes(metrics.process.memory.externalBytes)} />
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function SlowQueriesSection({
  queries,
  t,
}: {
  queries: AdminSlowQuery[];
  t: (key: string, replacements?: Record<string, string | number>) => string;
}) {
  return (
    <section className="space-y-4" data-testid="admin-slow-queries">
      <SectionHeading title={t("adminPage.slowQueriesTitle")} description={t("adminPage.slowQueriesDescription")} />
      <div className="overflow-hidden border border-border-primary bg-surface-card">
        {queries.length === 0 ? (
          <LoadingPanel label={t("adminPage.noSlowQueries")} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[680px] text-left text-sm">
              <thead className="border-b border-border-primary bg-surface-muted text-xs uppercase tracking-wider text-text-muted">
                <tr>
                  <th className="px-4 py-3">{t("adminPage.query")}</th>
                  <th className="whitespace-nowrap px-4 py-3">{t("adminPage.duration")}</th>
                  <th className="whitespace-nowrap px-4 py-3">{t("adminPage.time")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border-primary/60">
                {queries.map((query, index) => (
                  <tr key={`${query.at}-${index}`}>
                    <td className="max-w-2xl whitespace-pre-wrap break-words px-4 py-3 font-mono text-xs">{query.query}</td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">{query.durationMs} ms</td>
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-text-muted">{formatTimestamp(query.at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}

function LogsSection({
  entries,
  t,
}: {
  entries: AdminLogEntry[];
  t: (key: string, replacements?: Record<string, string | number>) => string;
}) {
  const renderedEntries = useMemo(
    () => entries.map((entry) => JSON.stringify(entry)).join("\n"),
    [entries],
  );

  return (
    <section className="space-y-4" data-testid="admin-logs">
      <SectionHeading title={t("adminPage.logsTitle")} description={t("adminPage.logsDescription")} />
      <div className="border border-border-primary bg-slate-950 p-4 text-slate-100">
        {entries.length === 0 ? (
          <p className="font-mono text-xs text-slate-400">{t("adminPage.noLogs")}</p>
        ) : (
          <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words font-mono text-xs leading-6">{renderedEntries}</pre>
        )}
      </div>
    </section>
  );
}

function SectionHeading({ title, description }: { title: string; description: string }) {
  return (
    <div>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-1 text-sm text-text-muted">{description}</p>
    </div>
  );
}

function MetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="border border-border-primary bg-surface-card p-4">
      <p className="text-[10px] font-bold uppercase tracking-wider text-text-muted">{label}</p>
      <p className="mt-2 font-mono text-lg font-semibold text-foreground">{value}</p>
    </div>
  );
}

function LoadingPanel({ label }: { label: string }) {
  return <p className="border border-border-primary bg-surface-card p-6 text-sm text-text-muted">{label}</p>;
}
