import { describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import AdminPage from "@/components/pages/AdminPage";
import {
  __getApiCallLog,
  __holdNextAdminMonitoring,
  __resetApiMock,
  __setAdminAccess,
  __setAdminHealthStatus,
  __setAdminMonitoringStatus,
  setActiveAccessToken,
} from "./mocks/api";
import { __getPathname, __resetNavigation } from "./mocks/next-navigation";

vi.mock("@/context/ChatContext", () => ({
  useChat: () => ({
    isAuthenticated: true,
    isMounted: true,
    user: { userId: "user-1" },
  }),
  useUiLanguage: () => "en",
}));

describe("AdminPage", () => {
  test.beforeEach(() => {
    __resetApiMock();
    __resetNavigation("/");
  });

  test("renders all monitoring sections after the admin check succeeds", async () => {
    __setAdminAccess(true);

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.queryByTestId("admin-metrics")).toBeTruthy();
    });

    expect(screen.queryByTestId("admin-slow-queries")).toBeTruthy();
    expect(screen.queryByTestId("admin-logs")).toBeTruthy();
    expect(__getApiCallLog("getAdminHealth")).toHaveLength(1);
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);
    expect(__getApiCallLog("getAdminLogs")).toHaveLength(1);
    expect(__getApiCallLog("getAdminSlowQueries")).toHaveLength(1);
  });

  test("does not render monitoring sections for a non-admin", async () => {
    __setAdminAccess(false);

    render(<AdminPage />);

    await waitFor(() => {
      expect(screen.queryByTestId("admin-forbidden")).toBeTruthy();
    });

    expect(screen.queryByTestId("admin-metrics")).toBeNull();
    expect(screen.queryByTestId("admin-slow-queries")).toBeNull();
    expect(screen.queryByTestId("admin-logs")).toBeNull();
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(0);
    expect(__getApiCallLog("getAdminLogs")).toHaveLength(0);
    expect(__getApiCallLog("getAdminSlowQueries")).toHaveLength(0);
  });

  test("redirects to login when the fresh health check returns 401", async () => {
    __setAdminHealthStatus(401);

    render(<AdminPage />);

    await waitFor(() => {
      expect(__getPathname()).toBe("/login?redirect=/admin");
    });
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(0);
    expect(__getApiCallLog("getAdminLogs")).toHaveLength(0);
    expect(__getApiCallLog("getAdminSlowQueries")).toHaveLength(0);
  });

  test("polls again after five seconds without overlapping a deferred batch", async () => {
    vi.useFakeTimers();
    try {
      __setAdminAccess(true);
      render(<AdminPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);
      const release = __holdNextAdminMonitoring();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2);

      release();
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  test("redirects and stops polling when monitoring returns 401", async () => {
    vi.useFakeTimers();
    try {
      __setAdminAccess(true);
      render(<AdminPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);

      __setAdminMonitoringStatus(401);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getPathname()).toBe("/login?redirect=/admin");
      const callsAfterUnauthorized = __getApiCallLog("getAdminMetrics").length;

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(callsAfterUnauthorized);
    } finally {
      vi.useRealTimers();
    }
  });

  test("redirects when the token disappears before the next poll", async () => {
    vi.useFakeTimers();
    try {
      __setAdminAccess(true);
      render(<AdminPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);
      act(() => {
        setActiveAccessToken(null);
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getPathname()).toBe("/login?redirect=/admin");
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test("does not schedule another poll after cleanup of a deferred batch", async () => {
    vi.useFakeTimers();
    try {
      __setAdminAccess(true);
      const { unmount } = render(<AdminPage />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const release = __holdNextAdminMonitoring();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2);

      unmount();
      release();
      await act(async () => {
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
