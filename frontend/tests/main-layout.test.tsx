import { beforeEach, describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MainLayout from "@/app/(main)/layout";
import {
  __getApiCallLog,
  __resetApiMock,
  __setCurrentUserAdmin,
} from "./mocks/api";

describe("MainLayout admin navigation access", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetApiMock();
  });

  test("uses the shared profile state for desktop and mobile navigation", async () => {
    __setCurrentUserAdmin(true);

    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText("Admin")).toHaveLength(2);
    });
    expect(__getApiCallLog("getAdminHealth")).toHaveLength(0);
  });

  test("does not probe the protected admin route for a non-admin", async () => {
    __setCurrentUserAdmin(false);

    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    );

    await waitFor(() => expect(screen.getByText("content")).toBeTruthy());
    expect(screen.queryByLabelText("Admin")).toBeNull();
    expect(__getApiCallLog("getAdminHealth")).toHaveLength(0);
  });
});