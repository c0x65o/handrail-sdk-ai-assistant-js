import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type UIEventHandler,
} from "react";

export interface SmartTranscriptFollowOptions {
  /** Reset to the latest message when the selected conversation changes. */
  readonly conversationId?: string | null;
  /** Changes whenever transcript content or streaming state changes. */
  readonly contentVersion: unknown;
  /** Distance from the bottom still considered pinned. Defaults to 48px. */
  readonly thresholdPixels?: number;
}

export interface SmartTranscriptFollowResult {
  readonly transcriptRef: (element: HTMLElement | null) => void;
  readonly onScroll: UIEventHandler<HTMLElement>;
  readonly following: boolean;
  readonly hasNewContent: boolean;
  scrollToLatest(behavior?: ScrollBehavior): void;
}

/** Follow a growing transcript without stealing a reader's scroll position. */
export function useSmartTranscriptFollow(
  options: SmartTranscriptFollowOptions,
): SmartTranscriptFollowResult {
  const threshold = options.thresholdPixels ?? 48;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new TypeError("thresholdPixels must be a non-negative finite number");
  }
  const elementRef = useRef<HTMLElement | null>(null);
  const [element, setElement] = useState<HTMLElement | null>(null);
  const followingRef = useRef(true);
  const smoothScrollRef = useRef(false);
  const positionRef = useRef({ top: 0, height: 0, viewport: 0 });
  const [following, setFollowing] = useState(true);
  const [hasNewContent, setHasNewContent] = useState(false);

  const updateFollowing = useCallback((next: boolean) => {
    followingRef.current = next;
    setFollowing(next);
    if (next) setHasNewContent(false);
  }, []);
  const scrollToLatest = useCallback((behavior: ScrollBehavior = "smooth") => {
    const element = elementRef.current;
    if (!element) return;
    updateFollowing(true);
    const reducedMotion = element.ownerDocument.defaultView?.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const effectiveBehavior = reducedMotion || behavior === "auto" ? "instant" : behavior;
    smoothScrollRef.current = effectiveBehavior === "smooth";
    if (typeof element.scrollTo === "function") element.scrollTo({ top: element.scrollHeight, behavior: effectiveBehavior });
    else element.scrollTop = element.scrollHeight;
    positionRef.current = { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight };
  }, [updateFollowing]);
  const transcriptRef = useCallback((element: HTMLElement | null) => {
    elementRef.current = element;
    setElement(element);
    if (element) updateFollowing(true);
  }, [updateFollowing]);
  const onScroll = useCallback<UIEventHandler<HTMLElement>>((event) => {
    const element = event.currentTarget;
    const previous = positionRef.current;
    const top = element.scrollTop;
    const nearBottom = element.scrollHeight - top - element.clientHeight <= threshold;
    const layoutChanged = previous.height !== element.scrollHeight || previous.viewport !== element.clientHeight;
    // Layout and our own smooth jump can emit scroll events while still far
    // from the bottom. Only reader movement should turn following off.
    if (top < previous.top && !layoutChanged) {
      smoothScrollRef.current = false;
      updateFollowing(false);
    } else if (top > previous.top && nearBottom) {
      updateFollowing(true);
    } else if (!layoutChanged && !smoothScrollRef.current && top !== previous.top && !nearBottom) {
      updateFollowing(false);
    }
    if (element.scrollHeight - top - element.clientHeight <= 1) smoothScrollRef.current = false;
    positionRef.current = { top, height: element.scrollHeight, viewport: element.clientHeight };
  }, [threshold, updateFollowing]);

  useLayoutEffect(() => {
    smoothScrollRef.current = false;
    updateFollowing(true);
    scrollToLatest("auto");
  }, [element, options.conversationId, scrollToLatest, updateFollowing]);

  useLayoutEffect(() => {
    if (followingRef.current) scrollToLatest("auto");
    else if (elementRef.current) setHasNewContent(true);
  }, [options.contentVersion, scrollToLatest]);

  useEffect(() => {
    const view = element?.ownerDocument.defaultView;
    if (!element || !view) return;
    let frame: number | undefined;
    let disposed = false;
    let height = element.scrollHeight;
    const refresh = () => {
      if (disposed) return;
      const contentGrew = element.scrollHeight > height;
      height = element.scrollHeight;
      if (followingRef.current) scrollToLatest("auto");
      else if (contentGrew) setHasNewContent(true);
    };
    const schedule = () => {
      if (frame !== undefined || disposed) return;
      frame = view.requestAnimationFrame(() => { frame = undefined; refresh(); });
    };
    // The scrollport has a fixed height. Observe its content too, including
    // late image/font layout and nodes added by host message renderers.
    const resize = typeof view.ResizeObserver === "function" ? new view.ResizeObserver(schedule) : null;
    const observeContent = () => {
      resize?.disconnect();
      resize?.observe(element);
      for (const child of Array.from(element.children)) resize?.observe(child);
    };
    observeContent();
    const mutation = new view.MutationObserver((records) => {
      if (records.some((record) => record.type === "childList")) observeContent();
      schedule();
    });
    mutation.observe(element, { childList: true, subtree: true, characterData: true });

    const pause = () => {
      updateFollowing(false);
      if (smoothScrollRef.current) element.scrollTo?.({ top: element.scrollTop, behavior: "instant" });
      smoothScrollRef.current = false;
    };
    const wheel = (event: WheelEvent) => { if (event.deltaY < 0 && !event.ctrlKey) pause(); };
    let touchY: number | undefined;
    const touchStart = (event: TouchEvent) => { touchY = event.touches[0]?.clientY; };
    const touchMove = (event: TouchEvent) => {
      const nextY = event.touches[0]?.clientY;
      if (nextY !== undefined && touchY !== undefined && nextY > touchY) pause();
      touchY = nextY;
    };
    const keyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof view.HTMLElement && target.closest("input,textarea,select,[contenteditable=true]")) return;
      if (["ArrowUp", "PageUp", "Home"].includes(event.key) || (event.key === " " && event.shiftKey)) pause();
    };
    element.addEventListener("wheel", wheel, { passive: true });
    element.addEventListener("touchstart", touchStart, { passive: true });
    element.addEventListener("touchmove", touchMove, { passive: true });
    element.addEventListener("keydown", keyDown);
    return () => {
      disposed = true;
      if (frame !== undefined) view.cancelAnimationFrame(frame);
      resize?.disconnect();
      mutation.disconnect();
      element.removeEventListener("wheel", wheel);
      element.removeEventListener("touchstart", touchStart);
      element.removeEventListener("touchmove", touchMove);
      element.removeEventListener("keydown", keyDown);
    };
  }, [element, scrollToLatest, updateFollowing]);

  return Object.freeze({ transcriptRef, onScroll, following, hasNewContent, scrollToLatest });
}
