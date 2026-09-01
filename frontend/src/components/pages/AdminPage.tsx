"use client";

import React from "react";
import { useRouter } from "next/navigation";
import { ADMIN_POLL_INTERVAL_MS, useAdmin } from "@/context/ChatContext";
import type { AdminLogEntry, AdminMetricsResponse, AdminSlowQuery } from "@/lib/api";
import { useTranslation } from "@/hooks/useTranslation";
import { Button } from "@/components/ui/Button";

const STATUS_CLASSES = ["1xx", "2xx", "3xx", "4xx", "5xx", "other"] as const;

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
  const { adminAccess, adminError, adminMonitoring } = useAdmin();
  const { t } = useTranslation();

  if (adminAccess === "checking") {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-text-muted" data-testid="admin-loading">
        {t("common.loading")}
      </div>
    );
  }

  if (adminAccess === "forbidden" || adminAccess === "error") {
    const message = adminAccess === "forbidden"
      ? t("adminPage.forbiddenDescription")
      : t("adminPage.accessError");
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="admin-forbidden">
        <section className="w-full max-w-lg border border-border-primary bg-surface-card p-8 text-center">
          <h1 className="text-xl font-bold text-foreground">
            {adminAccess === "forbidden" ? t("adminPage.forbiddenTitle") : t("adminPage.errorTitle")}
          </h1>
          <p className="mt-3 text-sm text-text-muted">{message}</p>
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
            {adminMonitoring.lastUpdated !== null && (
              <p className="mt-1 font-mono">{t("adminPage.lastUpdated", { time: formatTimestamp(adminMonitoring.lastUpdated) })}</p>
            )}
          </div>
        </header>

        {adminError === "monitoring" && (
          <div className="border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-700 dark:text-red-300" role="alert">
            {t("adminPage.loadError")}
          </div>
        )}

        <MetricsSection metrics={adminMonitoring.metrics} />
        <SlowQueriesSection queries={adminMonitoring.slowQueries} />
        <LogsSection entries={adminMonitoring.logs} />
      </div>
    </main>
  );
}

function MetricsSection({ metrics }: { metrics: AdminMetricsResponse | null }) {
  const { t } = useTranslation();
  const heading = (
    <SectionHeading title={t("adminPage.metricsTitle")} description={t("adminPage.metricsDescription")} />
  );

  if (!metrics) {
    return (
      <section className="space-y-4" data-testid="admin-metrics">
        {heading}
        <LoadingPanel label={t("common.loading")} />
      </section>
    );
  }

  const { latency, statusClasses } = metrics.requests;
  const statusValues = STATUS_CLASSES.map((status) => [status, statusClasses[status]] as const);
  const maxStatusCount = Math.max(1, ...statusValues.map(([, count]) => count));

  return (
    <section className="space-y-4" data-testid="admin-metrics">
      {heading}
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
              <MetricCard label={t("adminPage.latencySamples")} value={formatNumber(latency.count)} />
              <MetricCard label={t("adminPage.average")} value={`${latency.avgMs} ms`} />
              <MetricCard label={t("adminPage.p50")} value={`${latency.p50Ms} ms`} />
              <MetricCard label={t("adminPage.p95")} value={`${latency.p95Ms} ms`} />
              <MetricCard label={t("adminPage.p99")} value={`${latency.p99Ms} ms`} />
              <MetricCard label={t("adminPage.maximum")} value={`${latency.maxMs} ms`} />
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
    </section>
  );
}

function SlowQueriesSection({ queries }: { queries: AdminSlowQuery[] }) {
  const { t } = useTranslation();

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

function LogsSection({ entries }: { entries: AdminLogEntry[] }) {
  const { t } = useTranslation();
  // Each poll delivers a fresh `entries` array, so memoizing on it never hits.
  const renderedEntries = entries.map((entry) => JSON.stringify(entry)).join("\n");

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
