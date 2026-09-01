import { describe, expect, test, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import AdminPage from "@/components/pages/AdminPage";

const mockAdminState = vi.hoisted(() => ({
  access: "allowed" as "checking" | "allowed" | "forbidden" | "error",
  error: null as "access" | "monitoring" | null,
  monitoring: {
    metrics: null,
    logs: [],
    slowQueries: [],
    lastUpdated: null,
  },
}));

vi.mock("@/context/ChatContext", () => ({
  ADMIN_POLL_INTERVAL_MS: 30_000,
  useChat: () => ({
    adminAccess: mockAdminState.access,
    adminError: mockAdminState.error,
    adminMonitoring: mockAdminState.monitoring,
  }),
  useUiLanguage: () => "en",
}));

describe("AdminPage", () => {
  test("renders context-owned monitoring sections for an allowed admin", () => {
    mockAdminState.access = "allowed";
    mockAdminState.error = null;

    render(<AdminPage />);

    expect(screen.queryByTestId("admin-page")).toBeTruthy();
    expect(screen.queryByTestId("admin-metrics")).toBeTruthy();
    expect(screen.queryByTestId("admin-slow-queries")).toBeTruthy();
    expect(screen.queryByTestId("admin-logs")).toBeTruthy();
  });

  test("does not render monitoring sections when context denies access", () => {
    mockAdminState.access = "forbidden";
    mockAdminState.error = null;

    render(<AdminPage />);

    expect(screen.queryByTestId("admin-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("admin-metrics")).toBeNull();
    expect(screen.queryByTestId("admin-slow-queries")).toBeNull();
    expect(screen.queryByTestId("admin-logs")).toBeNull();
  });

  test("renders the context-owned monitoring error", () => {
    mockAdminState.access = "error";
    mockAdminState.error = "monitoring";

    render(<AdminPage />);

    expect(screen.queryByTestId("admin-forbidden")).toBeTruthy();
    expect(screen.getByText("The monitoring data could not be loaded. Retrying automatically.")).toBeTruthy();
  });
});
