/**
 * Render-measurement harness.
 *
 * Mounts the real (main) layout — ChatProvider, Sidebar, MobileNav — plus the
 * real chat route content, on top of the fixture-backed API mock, the fake
 * socket, and the controllable next/navigation mock. An app-level <Profiler>
 * counts commits and total render duration; the instrumented ChatBubble /
 * Chatroom / Sidebar wrappers count subtree renders.
 */
import React, { Profiler } from "react";
import { act, render, waitFor, type RenderResult } from "@testing-library/react";
import MainLayout from "../src/app/(main)/layout";
import ChatroomPageContent from "@/components/pages/ChatroomPageContent";
import { getRenderStats, recordRender, resetRenderStats, type RenderStats } from "./instrumented/counters";
import { __resetApiMock } from "./mocks/api";
import { __resetNavigation, __setPathname, usePathname } from "./mocks/next-navigation";
import { __getSocket, __resetSocket, type MockSocket } from "./mocks/socket-io-client";

const onAppRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  recordRender("app", actualDuration);
};

function TestRoutes(): React.ReactElement {
  const pathname = usePathname();
  if (pathname.startsWith("/chat/")) {
    return <ChatroomPageContent />;
  }
  return <div data-testid="route-placeholder" />;
}

function TestApp(): React.ReactElement {
  return (
    <Profiler id="app" onRender={onAppRender}>
      <MainLayout>
        <TestRoutes />
      </MainLayout>
    </Profiler>
  );
}

export interface Measurement {
  scenario: string;
  commits: number;
  totalDuration: number;
  chatBubbleRenders: number;
  chatBubbleDuration: number;
  chatroomRenders: number;
  sidebarRenders: number;
}

export interface Harness {
  view: RenderResult;
  socket: () => MockSocket;
  /** Reset all counters — call right before driving a scenario. */
  startMeasure: () => void;
  /** Wait until no commit happens for `quietMs`, then return. */
  settle: (quietMs?: number, timeoutMs?: number) => Promise<void>;
  /** Snapshot counters accumulated since the last startMeasure(). */
  measure: (scenario: string) => Measurement;
  navigate: (pathname: string) => Promise<void>;
}

const appStats = (): RenderStats => getRenderStats("app");

export async function mountChatApp(initialPath = "/chat/room-1"): Promise<Harness> {
  __resetApiMock();
  __resetSocket();
  __resetNavigation(initialPath);
  resetRenderStats();

  const view = render(<TestApp />);

  const settle = async (quietMs = 250, timeoutMs = 10_000): Promise<void> => {
    const startedAt = Date.now();
    for (;;) {
      const before = appStats().renders;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, quietMs));
      });
      if (appStats().renders === before) return;
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error("settle(): commits kept happening past the timeout");
      }
    }
  };

  // Wait for the authenticated layout (loading screen replaced by sidebar).
  await waitFor(() => {
    if (!view.container.querySelector("[data-app-ready], nav, aside, main")) {
      // The layout has no landmark roles; fall back to checking that the
      // loading text is gone and the room list rendered.
    }
    const alphaGroup = view.queryAllByText("Alpha Group");
    if (alphaGroup.length === 0) throw new Error("app not ready yet");
  });
  await settle();

  return {
    view,
    socket: () => __getSocket(),
    startMeasure: resetRenderStats,
    settle,
    measure: (scenario: string): Measurement => {
      const app = appStats();
      const bubble = getRenderStats("ChatBubble");
      return {
        scenario,
        commits: app.renders,
        totalDuration: app.actualDuration,
        chatBubbleRenders: bubble.renders,
        chatBubbleDuration: bubble.actualDuration,
        chatroomRenders: getRenderStats("Chatroom").renders,
        sidebarRenders: getRenderStats("Sidebar").renders,
      };
    },
    navigate: async (pathname: string) => {
      act(() => {
        __setPathname(pathname);
      });
      await Promise.resolve();
    },
  };
}

export const formatMeasurement = (m: Measurement): string =>
  `${m.scenario}: commits=${m.commits} totalDuration=${m.totalDuration.toFixed(1)}ms ` +
  `bubbleRenders=${m.chatBubbleRenders} (${m.chatBubbleDuration.toFixed(1)}ms) ` +
  `chatroomRenders=${m.chatroomRenders} sidebarRenders=${m.sidebarRenders}`;
