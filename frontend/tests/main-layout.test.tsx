import { describe, expect, test } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import MainLayout from "@/app/(main)/layout";
import { __getApiCallLog, __resetApiMock, __setAdminAccess } from "./mocks/api";

describe("MainLayout admin navigation access", () => {
  test("shares one health check between desktop and mobile navigation", async () => {
    __resetApiMock();
    __setAdminAccess(true);

    render(
      <MainLayout>
        <div>content</div>
      </MainLayout>,
    );

    await waitFor(() => {
      expect(screen.getAllByLabelText("Admin")).toHaveLength(2);
    });
    expect(__getApiCallLog("getAdminHealth")).toHaveLength(1);
  });
});