import { useMemo, type CSSProperties, type MouseEvent } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

export interface HandrailMarkdownProps {
  readonly children: string;
  readonly className?: string;
  readonly style?: CSSProperties;
  /** User messages are literal text, even when they contain Markdown. */
  readonly role?: "assistant" | "system" | "user";
  readonly linkMode?: "external" | "new-window" | "same-window" | "disabled";
  readonly onLinkClick?: (href: string, event: MouseEvent<HTMLAnchorElement>) => void;
  /** Inline images are opt-in; attachments retain their separate authorized renderer. */
  readonly images?: boolean;
  readonly tableLabel?: string;
}

const plugins = [remarkGfm];
const cellStyle: CSSProperties = {
  border: "1px solid var(--hr-border, currentColor)", padding: ".5em .75em", verticalAlign: "top",
};

/** Shared URL policy. Never let a custom navigation callback receive an unsafe scheme. */
export function safeMarkdownUrl(value: string): string {
  const trimmed = value.trim();
  if (Array.from(trimmed).some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) || trimmed.includes("\\")) return "";
  if (trimmed.startsWith("//")) return "";
  try {
    const base = new URL("https://assistant.invalid");
    const url = new URL(trimmed, base);
    return url.origin === base.origin || ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? trimmed : "";
  } catch { return ""; }
}

/** SDK-owned CommonMark/GFM presentation shared by styled and custom chat screens. */
export function HandrailMarkdown({ children, className, style, role = "assistant",
  linkMode = "external", onLinkClick, images = false, tableLabel = "Markdown table" }: HandrailMarkdownProps) {
  const components = useMemo<Components>(() => ({
    a: ({ href, children: label, title }) => {
      const safeHref = href ? safeMarkdownUrl(href) : "";
      if (!safeHref || linkMode === "disabled") return <span>{label}</span>;
      const external = linkMode === "new-window" || (linkMode === "external" && /^https?:/iu.test(safeHref));
      return <a href={safeHref} title={title} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        onClick={onLinkClick ? (event) => onLinkClick(safeHref, event) : undefined}>{label}</a>;
    },
    img: ({ src, alt, title }) => images && typeof src === "string" && safeMarkdownUrl(src)
      ? <img src={src} alt={alt ?? ""} title={title} style={{ maxWidth: "100%", height: "auto" }}/> : null,
    pre: ({ children: content }) => <pre style={{ maxWidth: "100%", overflowX: "auto", whiteSpace: "pre" }}>{content}</pre>,
    table: ({ children: content }) => <div role="region" aria-label={tableLabel} tabIndex={0}
      style={{ maxWidth: "100%", minWidth: 0, overflowX: "auto", marginBlock: ".75em" }}>
      <table style={{ borderCollapse: "collapse", width: "max-content", minWidth: "100%" }}>{content}</table>
    </div>,
    th: ({ children: content, style: alignment }) => <th scope="col" style={{ ...cellStyle, ...alignment }}>{content}</th>,
    td: ({ children: content, style: alignment }) => <td style={{ ...cellStyle, ...alignment }}>{content}</td>,
  }), [images, linkMode, onLinkClick, tableLabel]);
  return <div className={["hr-chat__markdown", className].filter(Boolean).join(" ")}
    style={{ minWidth: 0, maxWidth: "100%", overflowWrap: "anywhere", ...style, whiteSpace: role === "user" ? "pre-wrap" : "normal" }}>
    {role === "user" ? children : <ReactMarkdown remarkPlugins={plugins} components={components}
      urlTransform={safeMarkdownUrl}>{children}</ReactMarkdown>}
  </div>;
}
