/**
 * Instrumented stand-in for `@/components/ui/ChatBubble` (see vitest.config.ts
 * alias). Renders the real component inside a <Profiler> so tests can count
 * how many message-bubble subtrees actually re-render per scenario — including
 * re-renders triggered by context subscriptions inside ChatBubble itself,
 * which a plain wrapper-function counter would miss.
 */
import React, { Profiler } from "react";
import {
  ChatBubble as RealChatBubble,
  type ChatBubbleProps,
} from "../../src/components/ui/ChatBubble";
import { recordRender } from "./counters";

export type { Attachment, ChatBubbleProps } from "../../src/components/ui/ChatBubble";

const onRender: React.ProfilerOnRenderCallback = (_id, _phase, actualDuration) => {
  recordRender("ChatBubble", actualDuration);
};

export function ChatBubble(props: ChatBubbleProps): React.ReactElement {
  return (
    <Profiler id={`ChatBubble:${props.messageId ?? "unknown"}`} onRender={onRender}>
      <RealChatBubble {...props} />
    </Profiler>
  );
}
