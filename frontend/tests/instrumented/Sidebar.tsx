/**
 * Instrumented stand-in for `@/components/layout/Sidebar` (see
 * vitest.config.ts alias): counts commits in which the sidebar subtree
 * (including ChatList) rendered.
 */
import React, { Profiler } from "react";
import RealSidebar from "../../src/components/layout/Sidebar";
import { recordRender } from "./counters";

const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  recordRender("Sidebar", actualDuration);
};

type SidebarProps = React.ComponentProps<typeof RealSidebar>;

export default function Sidebar(props: SidebarProps): React.ReactElement {
  return (
    <Profiler id="Sidebar" onRender={onRender}>
      <RealSidebar {...props} />
    </Profiler>
  );
}
