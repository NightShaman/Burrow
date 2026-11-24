import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ProgressEntry, ToolActivity } from '../../app/api';
import type { ChatInput } from './chatInputs';

type ScrollInputs = {
  isLoading: boolean;
  isNewSession: boolean;
  messageCount: number;
  isSending: boolean;
  liveProgress: ProgressEntry[];
  liveAnswer: string;
  activeActivity?: ToolActivity;
  chatInputs: ChatInput[];
  error: string;
  onLoadOlder?: () => Promise<void>;
};

export function useTranscriptScroll({
  isLoading,
  isNewSession,
  messageCount,
  isSending,
  liveProgress,
  liveAnswer,
  activeActivity,
  chatInputs,
  error,
  onLoadOlder,
}: ScrollInputs) {
  const messagesRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const pendingPinTop = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const pinToBottom = (container: HTMLDivElement) => {
    const previous = container.scrollTop;
    container.scrollTop = container.scrollHeight;
    if (container.scrollTop !== previous) pendingPinTop.current = container.scrollTop;
  };
  const updateScrollIntent = () => {
    const container = messagesRef.current;
    if (!container) return;
    // A scroll event from our own pin may arrive after another image grew.
    // The gap is then real, but the reader hasn't moved. Let resize re-pin it.
    const pinnedTop = pendingPinTop.current;
    pendingPinTop.current = null;
    if (stickToBottomRef.current && container.scrollTop === pinnedTop) return;
    stickToBottomRef.current =
      container.scrollHeight - container.scrollTop - container.clientHeight < 48;
    setShowJumpToLatest(!stickToBottomRef.current);
  };
  const syncScroll = () => {
    const container = messagesRef.current;
    if (!container) return;
    if (!isLoading && stickToBottomRef.current) pinToBottom(container);
    setShowJumpToLatest(
      container.scrollHeight - container.scrollTop - container.clientHeight >= 48,
    );
  };
  useLayoutEffect(syncScroll, [
    isLoading,
    isNewSession,
    messageCount,
    isSending,
    liveProgress,
    liveAnswer,
    activeActivity,
    chatInputs,
    error,
  ]);
  // Images, expanded tool details and viewport changes can alter the bottom
  // without adding a turn. Follow only when the reader has not scrolled away.
  useEffect(() => {
    const container = messagesRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncScroll);
    observer.observe(container);
    for (const child of container.children) observer.observe(child);
    return () => observer.disconnect();
  });
  const loadOlder = async () => {
    if (!onLoadOlder) return;
    const container = messagesRef.current;
    const height = container?.scrollHeight ?? 0;
    const top = container?.scrollTop ?? 0;
    stickToBottomRef.current = false;
    await onLoadOlder();
    requestAnimationFrame(() => {
      if (container && container === messagesRef.current && !stickToBottomRef.current)
        container.scrollTop = top + container.scrollHeight - height;
    });
  };
  const jumpToLatest = () => {
    const container = messagesRef.current;
    if (!container) return;
    stickToBottomRef.current = true;
    pinToBottom(container);
    setShowJumpToLatest(false);
  };
  return { messagesRef, showJumpToLatest, updateScrollIntent, loadOlder, jumpToLatest };
}
