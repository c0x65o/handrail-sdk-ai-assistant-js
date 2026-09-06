import {
  Children,
  cloneElement,
  createContext,
  forwardRef,
  isValidElement,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ForwardedRef,
  type HTMLAttributes,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import type { ConversationActivityProgress } from "../conversation/activity.js";

export type ChatLauncherConnectionStatus =
  | "connecting"
  | "connected"
  | "disconnected"
  | "error";
export type ChatLauncherTurnStatus = "idle" | "busy" | "completed" | "error";

export interface ChatLauncherState {
  activityProgress?: ConversationActivityProgress;
  activitySummary?: string;
  busy: boolean;
  connectionStatus?: ChatLauncherConnectionStatus;
  error: boolean;
  open: boolean;
  turnStatus?: ChatLauncherTurnStatus;
  unreadCount: number;
  runningCount: number;
}

type OpenChangeHandler = (open: boolean) => void;

interface LauncherInstance {
  content: HTMLElement | null;
  descriptions: Set<HTMLElement>;
  notify: () => void;
  panelId: string | null;
  restoreFocusOnClose: boolean;
  titles: Set<HTMLElement>;
  trigger: HTMLElement | null;
  state: {
    dismissOnOutsideInteraction: boolean;
    modal: boolean;
    onOpenChange: (open: boolean, restoreFocus?: boolean) => void;
    open: boolean;
  };
}

interface LauncherContextValue extends ChatLauncherState {
  descriptionId: string;
  instance: LauncherInstance;
  modal: boolean;
  panelId: string;
  titleId: string;
}

interface LauncherLayer {
  content: HTMLElement;
  instance: LauncherInstance;
}

const LauncherContext = createContext<LauncherContextValue | null>(null);
const layersByDocument = new WeakMap<Document, LauncherLayer[]>();
const useSafeLayoutEffect =
  typeof document === "undefined" ? useEffect : useLayoutEffect;

function useLauncherContext(component: string): LauncherContextValue {
  const context = useContext(LauncherContext);
  if (!context) {
    throw new Error(`${component} must be rendered within ChatLauncherRoot.`);
  }
  return context;
}

function getTopLayer(document: Document): LauncherLayer | undefined {
  return layersByDocument.get(document)?.at(-1);
}

function registerLayer(layer: LauncherLayer): () => void {
  const document = layer.content.ownerDocument;
  const layers = layersByDocument.get(document) ?? [];
  layers.push(layer);
  layersByDocument.set(document, layers);
  return () => {
    const current = layersByDocument.get(document);
    if (!current) return;
    const index = current.indexOf(layer);
    if (index >= 0) current.splice(index, 1);
    if (current.length === 0) layersByDocument.delete(document);
  };
}

function setRef<T>(ref: ForwardedRef<T> | undefined, value: T | null): void {
  if (typeof ref === "function") ref(value);
  else if (ref) ref.current = value;
}

function focusElement(element: HTMLElement): void {
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}

const focusableSelector = [
  "a[href]",
  "area[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "iframe",
  "object",
  "embed",
  "[contenteditable]:not([contenteditable='false'])",
  "[tabindex]",
].join(",");

function getFocusableElements(content: HTMLElement): HTMLElement[] {
  return Array.from(content.querySelectorAll<HTMLElement>(focusableSelector)).filter(
    (element) => {
      if (element.tabIndex < 0 || element.closest("[hidden],[aria-hidden='true']")) {
        return false;
      }
      if (element.matches(":disabled")) return false;
      const view = element.ownerDocument.defaultView;
      if (!view) return true;
      const style = view.getComputedStyle(element);
      return style.display !== "none" && style.visibility !== "hidden";
    },
  );
}

function focusFirst(content: HTMLElement): void {
  focusElement(getFocusableElements(content)[0] ?? content);
}

function cycleFocus(content: HTMLElement, backwards: boolean): void {
  const focusable = getFocusableElements(content);
  if (focusable.length === 0) return focusElement(content);
  const current = focusable.indexOf(
    content.ownerDocument.activeElement as HTMLElement,
  );
  const next = backwards
    ? current <= 0
      ? focusable.length - 1
      : current - 1
    : current < 0 || current === focusable.length - 1
      ? 0
      : current + 1;
  const target = focusable[next];
  if (target) focusElement(target);
}

function stateData(state: ChatLauncherState) {
  return {
    "data-activity-completed": state.activityProgress?.completed,
    "data-activity-total": state.activityProgress?.total,
    "data-activity-unit": state.activityProgress?.unit,
    "data-busy": state.busy ? "true" : "false",
    "data-connection-status": state.connectionStatus,
    "data-error": state.error ? "true" : "false",
    "data-state": state.open ? "open" : "closed",
    "data-turn-status": state.turnStatus,
    "data-unread-count": String(state.unreadCount),
    "data-running-count": String(state.runningCount),
  };
}

export interface ChatLauncherRootProps {
  activityProgress?: ConversationActivityProgress;
  activitySummary?: string;
  children?: ReactNode;
  connectionStatus?: ChatLauncherConnectionStatus;
  defaultOpen?: boolean;
  /** Whether pointer interaction outside the panel requests closing. */
  dismissOnOutsideInteraction?: boolean;
  /** Whether the panel behaves as a modal dialog instead of a non-modal region. */
  modal?: boolean;
  onOpenChange?: OpenChangeHandler;
  open?: boolean;
  turnStatus?: ChatLauncherTurnStatus;
  unreadCount?: number;
  runningCount?: number;
}

export function ChatLauncherRoot({
  activityProgress,
  activitySummary,
  children,
  connectionStatus,
  defaultOpen = false,
  dismissOnOutsideInteraction = true,
  modal = false,
  onOpenChange,
  open: controlledOpen,
  turnStatus,
  unreadCount = 0,
  runningCount = 0,
}: ChatLauncherRootProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;
  const [registrationVersion, notify] = useReducer(
    (version: number) => version + 1,
    0,
  );
  const reactId = useId();
  const generatedPanelId = `handrail-chat-launcher-panel-${reactId}`;
  const instanceRef = useRef<LauncherInstance | null>(null);
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);
  const wasOpenRef = useRef(false);
  const openRef = useRef(open);

  if (!instanceRef.current) {
    instanceRef.current = {
      content: null,
      descriptions: new Set(),
      notify,
      panelId: null,
      restoreFocusOnClose: false,
      titles: new Set(),
      trigger: null,
      state: {
        dismissOnOutsideInteraction,
        modal,
        onOpenChange: () => undefined,
        open,
      },
    };
  }
  const instance = instanceRef.current;
  instance.notify = notify;
  instance.state = {
    dismissOnOutsideInteraction,
    modal,
    onOpenChange(nextOpen, restoreFocus = false) {
      if (!nextOpen) instance.restoreFocusOnClose = restoreFocus;
      if (controlledOpen === undefined) setUncontrolledOpen(nextOpen);
      onOpenChange?.(nextOpen);
    },
    open,
  };
  openRef.current = open;

  useSafeLayoutEffect(() => {
    if (open && !wasOpenRef.current) {
      const active = typeof document === "undefined" ? null : document.activeElement;
      previouslyFocusedRef.current = active instanceof HTMLElement ? active : null;
      instance.restoreFocusOnClose = false;
    } else if (!open && wasOpenRef.current) {
      const active = typeof document === "undefined" ? null : document.activeElement;
      const focusWasInPanel =
        active instanceof Node && Boolean(instance.content?.contains(active));
      if (modal || instance.restoreFocusOnClose || focusWasInPanel) {
        const target = instance.trigger ?? previouslyFocusedRef.current;
        queueMicrotask(() => {
          if (target?.isConnected) focusElement(target);
        });
      }
      instance.restoreFocusOnClose = false;
    }
    wasOpenRef.current = open;
  }, [instance, modal, open]);

  useSafeLayoutEffect(
    () => () => {
      if (!openRef.current) return;
      const active = typeof document === "undefined" ? null : document.activeElement;
      if (!modal && !(active instanceof Node && instance.content?.contains(active))) {
        return;
      }
      const target = instance.trigger ?? previouslyFocusedRef.current;
      queueMicrotask(() => {
        if (target?.isConnected) focusElement(target);
      });
    },
    [instance, modal],
  );

  const normalizedUnreadCount = Number.isFinite(unreadCount)
    ? Math.max(0, Math.floor(unreadCount))
    : 0;
  const normalizedRunningCount = Number.isFinite(runningCount) ? Math.max(0, Math.floor(runningCount)) : 0;
  const value = useMemo<LauncherContextValue>(
    () => ({
      ...(activityProgress === undefined ? {} : { activityProgress }),
      ...(activitySummary === undefined ? {} : { activitySummary }),
      busy: normalizedRunningCount > 0 || turnStatus === "busy",
      ...(connectionStatus === undefined ? {} : { connectionStatus }),
      descriptionId: `handrail-chat-launcher-description-${reactId}`,
      error: connectionStatus === "error" || turnStatus === "error",
      instance,
      modal,
      open,
      panelId: instance.panelId ?? generatedPanelId,
      titleId: `handrail-chat-launcher-title-${reactId}`,
      ...(turnStatus === undefined ? {} : { turnStatus }),
      unreadCount: normalizedUnreadCount,
      runningCount: normalizedRunningCount,
    }),
    [
      connectionStatus,
      activityProgress,
      activitySummary,
      generatedPanelId,
      instance,
      modal,
      normalizedUnreadCount,
      normalizedRunningCount,
      open,
      reactId,
      registrationVersion,
      turnStatus,
    ],
  );

  return <LauncherContext.Provider value={value}>{children}</LauncherContext.Provider>;
}

interface ChildTriggerProps extends HTMLAttributes<HTMLElement> {
  ref?: ForwardedRef<HTMLElement>;
}

export interface ChatLauncherTriggerProps
  extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Merge launcher behavior into the single consumer element instead of rendering a button. */
  asChild?: boolean;
}

export const ChatLauncherTrigger = forwardRef<
  HTMLElement,
  ChatLauncherTriggerProps
>(function ChatLauncherTrigger(
  {
    asChild = false,
    children,
    onClick,
    onKeyDown,
    type,
    "aria-controls": ariaControls,
    "aria-expanded": ariaExpanded,
    "aria-haspopup": ariaHasPopup,
    ...props
  },
  forwardedRef,
) {
  const context = useLauncherContext("ChatLauncherTrigger");
  const { instance, modal, open, panelId } = context;
  const childNode = asChild ? Children.only(children) : null;
  if (asChild && !isValidElement<ChildTriggerProps>(childNode)) {
    throw new Error("ChatLauncherTrigger asChild requires one valid React element.");
  }
  const child = isValidElement<ChildTriggerProps>(childNode) ? childNode : null;
  const childProps = child?.props;
  const isNativeInteractive =
    typeof child?.type === "string" &&
    (["button", "input", "select", "textarea", "a"].includes(child.type));
  const attachRef = useCallback(
    (node: HTMLElement | null) => {
      instance.trigger = node;
      setRef(childProps?.ref, node);
      setRef(forwardedRef, node);
    },
    [childProps?.ref, forwardedRef, instance],
  );
  const activate = (event: ReactMouseEvent<HTMLElement>) => {
    childProps?.onClick?.(event);
    if (!event.defaultPrevented) {
      (onClick as ((event: ReactMouseEvent<HTMLElement>) => void) | undefined)?.(
        event,
      );
    }
    if (!event.defaultPrevented) instance.state.onOpenChange(!open, open);
  };
  const keyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    childProps?.onKeyDown?.(event);
    if (!event.defaultPrevented) {
      (onKeyDown as
        | ((event: ReactKeyboardEvent<HTMLElement>) => void)
        | undefined)?.(event);
    }
    if (
      !event.defaultPrevented &&
      asChild &&
      !isNativeInteractive &&
      (event.key === "Enter" || event.key === " ")
    ) {
      event.preventDefault();
      instance.state.onOpenChange(!open, open);
    }
  };
  const shared = {
    ...stateData(context),
    "aria-controls": ariaControls ?? childProps?.["aria-controls"] ?? panelId,
    "aria-expanded": ariaExpanded ?? childProps?.["aria-expanded"] ?? open,
    "aria-haspopup":
      ariaHasPopup ?? childProps?.["aria-haspopup"] ?? (modal ? "dialog" : undefined),
    onClick: activate,
    onKeyDown: keyDown,
    ref: attachRef,
  };

  if (child) {
    return cloneElement(child, {
      ...props,
      ...shared,
      role: childProps?.role ?? (isNativeInteractive ? undefined : "button"),
      tabIndex: childProps?.tabIndex ?? (isNativeInteractive ? undefined : 0),
    });
  }
  return (
    <button
      {...props}
      {...shared}
      type={type ?? "button"}
    >
      {children}
    </button>
  );
});

export interface ChatLauncherPortalProps {
  children?: ReactNode;
  container?: Element | DocumentFragment | null;
}

export function ChatLauncherPortal({ children, container }: ChatLauncherPortalProps) {
  const { open } = useLauncherContext("ChatLauncherPortal");
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!open || !mounted || typeof document === "undefined") return null;
  return createPortal(children, container ?? document.body);
}

export interface ChatLauncherPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** Element to focus when a modal panel opens, before the first tabbable fallback. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Called for pointer interaction outside this panel. Prevent default to veto dismissal. */
  onInteractOutside?: (event: PointerEvent) => void;
}

export const ChatLauncherPanel = forwardRef<HTMLDivElement, ChatLauncherPanelProps>(
  function ChatLauncherPanel(
    {
      initialFocusRef,
      onInteractOutside,
      role,
      tabIndex,
      "aria-label": ariaLabel,
      "aria-labelledby": ariaLabelledBy,
      "aria-describedby": ariaDescribedBy,
      "aria-modal": ariaModal,
      ...props
    },
    forwardedRef,
  ) {
    const context = useLauncherContext("ChatLauncherPanel");
    const { instance, modal, open, panelId, titleId } = context;
    const contentRef = useRef<HTMLDivElement | null>(null);
    const initialFocusRefRef = useRef(initialFocusRef);
    const interactOutsideRef = useRef(onInteractOutside);
    initialFocusRefRef.current = initialFocusRef;
    interactOutsideRef.current = onInteractOutside;
    const resolvedId = props.id ?? panelId;

    const attachRef = useCallback(
      (node: HTMLDivElement | null) => {
        contentRef.current = node;
        instance.content = node;
        setRef(forwardedRef, node);
      },
      [forwardedRef, instance],
    );

    useSafeLayoutEffect(() => {
      if (instance.panelId === resolvedId) return;
      instance.panelId = resolvedId;
      instance.notify();
      return () => {
        if (instance.panelId === resolvedId) {
          instance.panelId = null;
          instance.notify();
        }
      };
    }, [instance, resolvedId]);

    const registeredTitleId = instance.titles.values().next().value?.id as
      | string
      | undefined;
    const registeredDescriptionId = instance.descriptions.values().next().value
      ?.id as string | undefined;
    const resolvedLabelledBy =
      ariaLabelledBy ?? (ariaLabel ? undefined : registeredTitleId ?? titleId);
    const resolvedDescribedBy = ariaDescribedBy ?? registeredDescriptionId;

    useSafeLayoutEffect(() => {
      if (!open) return;
      const content = contentRef.current;
      if (!content) return;
      const hasName = Boolean(
        ariaLabel?.trim() ||
          (ariaLabelledBy === undefined
            ? instance.titles.size > 0
            : ariaLabelledBy.trim()),
      );
      if (!hasName) {
        throw new Error(
          "ChatLauncherPanel requires an accessible name. Render ChatLauncherTitle, or provide aria-label or aria-labelledby.",
        );
      }

      const layer = { content, instance };
      const unregister = registerLayer(layer);
      const document = content.ownerDocument;
      let cancelled = false;
      const handleKeyDown = (event: KeyboardEvent) => {
        if (event.defaultPrevented || getTopLayer(document) !== layer) return;
        if (event.key === "Escape" && !event.isComposing) {
          event.preventDefault();
          instance.state.onOpenChange(false, true);
        } else if (event.key === "Tab" && instance.state.modal) {
          event.preventDefault();
          cycleFocus(content, event.shiftKey);
        }
      };
      const handleFocusIn = (event: FocusEvent) => {
        if (
          !instance.state.modal ||
          getTopLayer(document) !== layer ||
          event.composedPath().includes(content)
        ) return;
        focusFirst(content);
      };
      const handlePointerDown = (event: PointerEvent) => {
        if (
          event.defaultPrevented ||
          getTopLayer(document) !== layer ||
          event.composedPath().includes(content)
        ) return;
        interactOutsideRef.current?.(event);
        if (!event.defaultPrevented && instance.state.dismissOnOutsideInteraction) {
          instance.state.onOpenChange(false, false);
        }
      };
      document.addEventListener("keydown", handleKeyDown);
      document.addEventListener("focusin", handleFocusIn);
      document.addEventListener("pointerdown", handlePointerDown);
      if (modal) {
        queueMicrotask(() => {
          if (cancelled || getTopLayer(document) !== layer) return;
          const requested = initialFocusRefRef.current?.current;
          const autofocus = content.querySelector<HTMLElement>("[autofocus]");
          focusElement(
            (requested && content.contains(requested) ? requested : null) ??
              autofocus ??
              getFocusableElements(content)[0] ??
              content,
          );
        });
      }
      return () => {
        cancelled = true;
        document.removeEventListener("keydown", handleKeyDown);
        document.removeEventListener("focusin", handleFocusIn);
        document.removeEventListener("pointerdown", handlePointerDown);
        unregister();
      };
    }, [ariaLabel, ariaLabelledBy, instance, modal, open]);

    if (!open) return null;
    return (
      <div
        {...props}
        {...stateData(context)}
        ref={attachRef}
        id={resolvedId}
        role={role ?? (modal ? "dialog" : "region")}
        aria-modal={ariaModal ?? (modal ? true : undefined)}
        aria-label={ariaLabel}
        aria-labelledby={resolvedLabelledBy}
        aria-describedby={resolvedDescribedBy}
        tabIndex={tabIndex ?? (modal ? -1 : undefined)}
      />
    );
  },
);

export type ChatLauncherTitleProps = HTMLAttributes<HTMLHeadingElement>;

export const ChatLauncherTitle = forwardRef<
  HTMLHeadingElement,
  ChatLauncherTitleProps
>(function ChatLauncherTitle({ id, ...props }, forwardedRef) {
  const context = useLauncherContext("ChatLauncherTitle");
  const { instance, open, titleId } = context;
  const previousRef = useRef<HTMLHeadingElement | null>(null);
  const attachRef = useCallback(
    (node: HTMLHeadingElement | null) => {
      if (previousRef.current) instance.titles.delete(previousRef.current);
      previousRef.current = node;
      if (node) instance.titles.add(node);
      setRef(forwardedRef, node);
    },
    [forwardedRef, instance],
  );
  useSafeLayoutEffect(() => {
    instance.notify();
    return () => instance.notify();
  }, [id, instance]);
  if (!open) return null;
  return <h2 {...props} {...stateData(context)} ref={attachRef} id={id ?? titleId} />;
});

export type ChatLauncherDescriptionProps = HTMLAttributes<HTMLParagraphElement>;

export const ChatLauncherDescription = forwardRef<
  HTMLParagraphElement,
  ChatLauncherDescriptionProps
>(function ChatLauncherDescription({ id, ...props }, forwardedRef) {
  const context = useLauncherContext("ChatLauncherDescription");
  const { descriptionId, instance, open } = context;
  const previousRef = useRef<HTMLParagraphElement | null>(null);
  const attachRef = useCallback(
    (node: HTMLParagraphElement | null) => {
      if (previousRef.current) instance.descriptions.delete(previousRef.current);
      previousRef.current = node;
      if (node) instance.descriptions.add(node);
      setRef(forwardedRef, node);
    },
    [forwardedRef, instance],
  );
  useSafeLayoutEffect(() => {
    instance.notify();
    return () => instance.notify();
  }, [id, instance]);
  if (!open) return null;
  return (
    <p
      {...props}
      {...stateData(context)}
      ref={attachRef}
      id={id ?? descriptionId}
    />
  );
});

export type ChatLauncherCloseProps = ButtonHTMLAttributes<HTMLButtonElement>;

export const ChatLauncherClose = forwardRef<
  HTMLButtonElement,
  ChatLauncherCloseProps
>(function ChatLauncherClose({ onClick, type, ...props }, forwardedRef) {
  const context = useLauncherContext("ChatLauncherClose");
  if (!context.open) return null;
  return (
    <button
      {...props}
      {...stateData(context)}
      ref={forwardedRef}
      type={type ?? "button"}
      onClick={(event) => {
        onClick?.(event);
        if (!event.defaultPrevented) context.instance.state.onOpenChange(false, true);
      }}
    />
  );
});

type LauncherRenderProp = ReactNode | ((state: ChatLauncherState) => ReactNode);

export interface ChatLauncherBadgeProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children?: LauncherRenderProp;
}

function publicState(context: LauncherContextValue): ChatLauncherState {
  return {
    ...(context.activityProgress === undefined ? {} : { activityProgress: context.activityProgress }),
    ...(context.activitySummary === undefined ? {} : { activitySummary: context.activitySummary }),
    busy: context.busy,
    ...(context.connectionStatus === undefined
      ? {}
      : { connectionStatus: context.connectionStatus }),
    error: context.error,
    open: context.open,
    ...(context.turnStatus === undefined
      ? {}
      : { turnStatus: context.turnStatus }),
    unreadCount: context.unreadCount,
    runningCount: context.runningCount,
  };
}

export const ChatLauncherBadge = forwardRef<
  HTMLSpanElement,
  ChatLauncherBadgeProps
>(function ChatLauncherBadge(
  { children, role, "aria-label": ariaLabel, "aria-live": ariaLive, ...props },
  forwardedRef,
) {
  const context = useLauncherContext("ChatLauncherBadge");
  const state = publicState(context);
  const unreadLabel = state.unreadCount === 0
    ? "No unread messages"
    : `${state.unreadCount} unread ${state.unreadCount === 1 ? "message" : "messages"}`;
  return (
    <span
      {...props}
      {...stateData(state)}
      ref={forwardedRef}
      role={role ?? "status"}
      aria-label={ariaLabel ?? unreadLabel}
      aria-live={ariaLive ?? "polite"}
    >
      {typeof children === "function" ? children(state) : children ?? state.unreadCount}
    </span>
  );
});

export interface ChatLauncherStatusProps
  extends Omit<HTMLAttributes<HTMLSpanElement>, "children"> {
  children?: LauncherRenderProp;
}

function statusText(state: ChatLauncherState): string {
  const parts = [
    state.unreadCount === 0
      ? "No unread messages"
      : `${state.unreadCount} unread ${state.unreadCount === 1 ? "message" : "messages"}`,
  ];
  if (state.activitySummary) {
    const progress = state.activityProgress;
    parts.push(progress
      ? `${state.activitySummary}. ${progress.completed} of ${progress.total}${progress.unit ? ` ${progress.unit}` : ""}`
      : state.activitySummary);
  }
  if (state.busy) parts.push(state.runningCount > 1 ? `${state.runningCount} conversations running` : "Running");
  return parts.join(". ");
}

export const ChatLauncherStatus = forwardRef<
  HTMLSpanElement,
  ChatLauncherStatusProps
>(function ChatLauncherStatus(
  { children, role, "aria-live": ariaLive, ...props },
  forwardedRef,
) {
  const context = useLauncherContext("ChatLauncherStatus");
  const state = publicState(context);
  return (
    <span
      {...props}
      {...stateData(state)}
      ref={forwardedRef}
      role={role ?? "status"}
      aria-live={ariaLive ?? "polite"}
    >
      {typeof children === "function" ? children(state) : children ?? statusText(state)}
    </span>
  );
});
