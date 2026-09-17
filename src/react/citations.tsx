import type { ConversationPresentationState as ConversationState } from "../conversation/presentation.js";
import {
  Fragment,
  forwardRef,
  type AnchorHTMLAttributes,
  type HTMLAttributes,
  type LiHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from "react";

import {
  normalizeCitationSource,
  type Citation,
  type CitationSource,
} from "../citations.js";
import type { } from "../conversation/state.js";
import { useResolvedState } from "./primitive-context.js";
import type { PrimitiveRender } from "./primitives.js";

export type CitationRenderer = (
  citation: Citation,
  source: CitationSource,
  index: number,
) => ReactNode;

export type CitationLocatorRenderer = (
  locator: string,
  source: CitationSource,
  citation: Citation,
) => ReactNode;

export type CitationLocatorActivateHandler = (
  source: CitationSource,
  citation: Citation,
  event: MouseEvent<HTMLAnchorElement>,
) => void;

interface ResolvedCitation {
  readonly citation: Citation;
  readonly source: CitationSource;
  readonly firstSeenIndex: number;
}

function matchesTarget(
  citation: Citation,
  messageId: string | undefined,
  toolCallId: string | undefined,
): boolean {
  if (messageId !== undefined) {
    return citation.target.type === "assistant_message" &&
      citation.target.message_id === messageId;
  }
  if (toolCallId !== undefined) {
    return citation.target.type === "tool_result" &&
      citation.target.tool_call_id === toolCallId;
  }
  return true;
}

function resolveCitations(
  citations: readonly Citation[],
  sources: readonly CitationSource[],
  messageId: string | undefined,
  toolCallId: string | undefined,
): readonly ResolvedCitation[] {
  const sourceById = new Map<string, CitationSource>();
  for (const source of sources) {
    if (!sourceById.has(source.source_id)) sourceById.set(source.source_id, source);
  }

  const citationIds = new Set<string>();
  const resolved: ResolvedCitation[] = [];
  citations.forEach((citation, firstSeenIndex) => {
    if (citationIds.has(citation.citation_id)) return;
    citationIds.add(citation.citation_id);
    if (!matchesTarget(citation, messageId, toolCallId)) return;
    const source = sourceById.get(citation.source_id);
    if (source === undefined) return;
    resolved.push({ citation, source, firstSeenIndex });
  });

  return resolved.sort((left, right) =>
    left.citation.order - right.citation.order ||
    left.firstSeenIndex - right.firstSeenIndex);
}

function safePublicWebLocator(source: CitationSource): string | undefined {
  if (source.type !== "web" || source.locator === undefined) return undefined;
  try {
    return normalizeCitationSource(source).locator;
  } catch {
    return undefined;
  }
}

export interface CitationListProps
  extends Omit<HTMLAttributes<HTMLUListElement>, "children"> {
  /** Normalized links. Defaults to the nearest conversation state. */
  citations?: readonly Citation[];
  children?: ReactNode;
  /** Select only citations attached to this assistant message. */
  messageId?: string;
  render?: PrimitiveRender<HTMLUListElement, HTMLAttributes<HTMLUListElement>>;
  renderCitation?: CitationRenderer;
  renderLocator?: CitationLocatorRenderer;
  /** Normalized sources. Defaults to the nearest conversation state. */
  sources?: readonly CitationSource[];
  state?: ConversationState;
  /** Select only citations attached to this tool result. */
  toolCallId?: string;
}

/** An unstyled, ordered view of normalized durable citations. */
export const CitationList = forwardRef<HTMLUListElement, CitationListProps>(
  function CitationList(
    {
      children,
      citations: explicitCitations,
      messageId,
      render,
      renderCitation,
      renderLocator,
      sources: explicitSources,
      state: explicitState,
      toolCallId,
      ...props
    },
    forwardedRef,
  ) {
    if (messageId !== undefined && toolCallId !== undefined) {
      throw new TypeError("CitationList accepts either messageId or toolCallId, not both");
    }
    const state = useResolvedState(explicitState);
    const citations = explicitCitations ?? state?.citations ?? [];
    const sources = explicitSources ?? state?.citation_sources ?? [];
    const resolved = resolveCitations(citations, sources, messageId, toolCallId);
    if (resolved.length === 0 && (children === undefined || children === null)) {
      return null;
    }

    const content = children ?? resolved.map(({ citation, source }, index) => (
      <Fragment key={citation.citation_id}>
        {renderCitation
          ? renderCitation(citation, source, index)
          : (
            <CitationItem
              citation={citation}
              source={source}
              {...(renderLocator === undefined ? {} : { renderLocator })}
            />
          )}
      </Fragment>
    ));
    const nativeProps: HTMLAttributes<HTMLUListElement> = {
      ...props,
      children: content,
      "aria-label": props["aria-label"] ?? "Citations",
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <ul {...nativeProps} ref={forwardedRef} />;
  },
);

export interface CitationItemNativeProps extends LiHTMLAttributes<HTMLLIElement> {
  "data-citation-id"?: string;
  "data-source-id"?: string;
  "data-source-type"?: string;
}

export interface CitationItemProps
  extends Omit<CitationItemNativeProps, "children"> {
  citation: Citation;
  children?: ReactNode;
  linkProps?: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href">;
  onLocatorActivate?: CitationLocatorActivateHandler;
  render?: PrimitiveRender<HTMLLIElement, CitationItemNativeProps>;
  renderLocator?: CitationLocatorRenderer;
  source: CitationSource;
}

/** One source-backed citation. Only checked public web locators become links. */
export const CitationItem = forwardRef<HTMLLIElement, CitationItemProps>(
  function CitationItem(
    {
      children,
      citation,
      linkProps,
      onLocatorActivate,
      render,
      renderLocator,
      source,
      ...props
    },
    forwardedRef,
  ) {
    const safeHref = safePublicWebLocator(source);
    const locator = source.locator;
    const { children: linkChildren, onClick: onLinkClick, ...nativeLinkProps } =
      linkProps ?? {};
    const content = children ?? <>
      {safeHref === undefined
        ? <span>{source.label}</span>
        : (
          <a
            {...nativeLinkProps}
            href={safeHref}
            aria-label={nativeLinkProps["aria-label"] ?? `Open citation: ${source.label}`}
            onClick={(event) => {
              onLinkClick?.(event);
              if (!event.defaultPrevented) {
                onLocatorActivate?.(source, citation, event);
              }
            }}
          >
            {linkChildren ?? source.label}
          </a>
        )}
      <span>{source.type}</span>
      {renderLocator && locator !== undefined
        ? renderLocator(locator, source, citation)
        : null}
    </>;
    const nativeProps: CitationItemNativeProps = {
      ...props,
      children: content,
      "aria-label": props["aria-label"] ?? `${source.label}, ${source.type} source`,
      "data-citation-id": props["data-citation-id"] ?? citation.citation_id,
      "data-source-id": props["data-source-id"] ?? source.source_id,
      "data-source-type": props["data-source-type"] ?? source.type,
    };
    return render
      ? render(nativeProps, forwardedRef)
      : <li {...nativeProps} ref={forwardedRef} />;
  },
);
