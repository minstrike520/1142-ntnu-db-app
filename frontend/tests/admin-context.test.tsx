import { describe, expect, test, vi } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { ChatProvider, useChat } from "@/context/ChatContext";
import {
  __getApiCallLog,
  __holdNextAdminMonitoring,
  __resetApiMock,
  __setAdminAccess,
  __setAdminMonitoringStatus,
  setActiveAccessToken,
} from "./mocks/api";
import { __getPathname, __resetNavigation } from "./mocks/next-navigation";

function AdminContextProbe() {
  const { adminAccess, adminError, adminMonitoring, refreshAdminMonitoring } = useChat();
  return (
    <div data-testid="admin-context" data-access={adminAccess} data-error={adminError ?? ""}>
      <span data-testid="admin-data-loaded">{adminMonitoring.metrics ? "yes" : "no"}</span>
      <button type="button" onClick={refreshAdminMonitoring}>refresh</button>
    </div>
  );
}

describe("ChatContext admin monitoring lifecycle", () => {
  test.beforeEach(() => {
    __resetApiMock();
    __resetNavigation("/admin");
  });

  test("verifies access and loads monitoring data through the context", async () => {
    __setAdminAccess(true);
    render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("admin-context").getAttribute("data-access")).toBe("allowed"));
    await waitFor(() => expect(screen.getByTestId("admin-data-loaded").textContent).toBe("yes"));
    expect(__getApiCallLog("getAdminHealth")).toHaveLength(1);
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(1);
    expect(__getApiCallLog("getAdminLogs")).toHaveLength(1);
    expect(__getApiCallLog("getAdminSlowQueries")).toHaveLength(1);
  });

  test("stops before monitoring when access is forbidden", async () => {
    __setAdminAccess(false);
    render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("admin-context").getAttribute("data-access")).toBe("forbidden"));
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(0);
    expect(__getApiCallLog("getAdminLogs")).toHaveLength(0);
    expect(__getApiCallLog("getAdminSlowQueries")).toHaveLength(0);
  });

  test("keeps polling after a temporary monitoring failure", async () => {
    __setAdminAccess(true);
    render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("admin-data-loaded").textContent).toBe("yes"));

    __setAdminMonitoringStatus(500);
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(screen.getByTestId("admin-context").getAttribute("data-error")).toBe("monitoring"));

    __setAdminMonitoringStatus(null);
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(screen.getByTestId("admin-context").getAttribute("data-error")).toBe(""));
    expect(__getApiCallLog("getAdminMetrics").length).toBeGreaterThanOrEqual(3);
  });

  test("redirects and stops when monitoring returns 401", async () => {
    __setAdminAccess(true);
    render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("admin-data-loaded").textContent).toBe("yes"));

    __setAdminMonitoringStatus(401);
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(__getPathname()).toBe("/login?redirect=/admin"));
    const callsAfterUnauthorized = __getApiCallLog("getAdminMetrics").length;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(callsAfterUnauthorized);
  });

  test("revalidates the admin session after the token changes", async () => {
    __setAdminAccess(true);
    render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("admin-data-loaded").textContent).toBe("yes"));

    act(() => setActiveAccessToken("rotated-token"));
    await waitFor(() => expect(__getApiCallLog("getAdminHealth")).toHaveLength(2));
    await waitFor(() => expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2));
  });

  test("does not update state or schedule polling after unmount", async () => {
    __setAdminAccess(true);
    const view = render(
      <ChatProvider>
        <AdminContextProbe />
      </ChatProvider>,
    );
    await waitFor(() => expect(screen.getByTestId("admin-data-loaded").textContent).toBe("yes"));

    const release = __holdNextAdminMonitoring();
    act(() => screen.getByRole("button", { name: "refresh" }).click());
    await waitFor(() => expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2));
    view.unmount();
    release();
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2);
  });

  test("keeps two admin contexts within the shared request budget", async () => {
    __setAdminAccess(true);
    const view = render(
      <>
        <ChatProvider><AdminContextProbe /></ChatProvider>
        <ChatProvider><AdminContextProbe /></ChatProvider>
      </>,
    );
    await waitFor(() => expect(__getApiCallLog("getAdminMetrics")).toHaveLength(2));

    vi.useFakeTimers();
    try {
      for (const button of screen.getAllByRole("button", { name: "refresh" })) {
        act(() => button.click());
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(15 * 60 * 1_000);
      });

      const adminRequests = __getApiCallLog().filter(({ fn }) =>
        ["getAdminHealth", "getAdminMetrics", "getAdminLogs", "getAdminSlowQueries"].includes(fn),
      );
      expect(adminRequests.length).toBeLessThanOrEqual(200);
    } finally {
      vi.useRealTimers();
      view.unmount();
    }
  });
});
