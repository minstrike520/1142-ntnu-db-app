/**
 * Instrumented stand-in for `@/components/chat/Chatroom` (see vitest.config.ts
 * alias): counts commits in which the conversation pane subtree rendered.
 */
import React, { Profiler } from "react";
import RealChatroom from "../../src/components/chat/Chatroom";
import { recordRender } from "./counters";

const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  recordRender("Chatroom", actualDuration);
};

export default function Chatroom(
  props: React.ComponentProps<typeof RealChatroom>,
): React.ReactElement {
  return (
    <Profiler id="Chatroom" onRender={onRender}>
      <RealChatroom {...props} />
    </Profiler>
  );
}
