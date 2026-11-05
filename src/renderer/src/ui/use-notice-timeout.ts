import { useEffect, useRef, useState } from "react";

export const NOTICE_TIMEOUT_MS = 30_000;

// An informational notice that has reached its final state closes itself after
// the timeout. The countdown waits while the pointer rests on the notice and
// starts again in full when it leaves. Notices that still need the user stay
// inactive and never close on their own.
export function useNoticeTimeout(active: boolean, onDismiss: () => void, delay = NOTICE_TIMEOUT_MS) {
  const [hovered, setHovered] = useState(false);
  const dismiss = useRef(onDismiss);
  dismiss.current = onDismiss;
  useEffect(() => {
    if (!active || hovered) return;
    const timer = setTimeout(() => dismiss.current(), delay);
    return () => clearTimeout(timer);
  }, [active, hovered, delay]);
  return { onMouseEnter: () => setHovered(true), onMouseLeave: () => setHovered(false) };
}
