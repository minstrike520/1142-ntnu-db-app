import type { ReactNode } from "react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MainLayout from "@/app/(main)/layout";
import { __getPathname, __resetNavigation } from "./mocks/next-navigation";

vi.mock("@/context/ChatContext", () => ({
  ChatProvider: ({ children }: { children: ReactNode }) => children,
  useChat: () => ({
    isAuthenticated: false,
    isAuthResolved: true,
    isMounted: true,
    user: {},
  }),
  useUiLanguage: () => "en",
}));

describe("MainLayout unauthenticated route handling", () => {
  beforeEach(() => {
    __resetNavigation("/admin");
  });

  test("preserves the admin destination when redirecting to login", async () => {
    render(
      <MainLayout>
        <div data-testid="protected-content">protected content</div>
      </MainLayout>,
    );

    await waitFor(() => {
      expect(__getPathname()).toBe("/login?redirect=%2Fadmin");
    });
    expect(screen.queryByTestId("protected-content")).toBeNull();
  });
});
