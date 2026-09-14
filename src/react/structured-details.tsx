import { useState, type HTMLAttributes, type ReactNode } from "react";
import type { ConversationStateJsonValue } from "../conversation/state.js";

/** Format field names only. Values (including money, dates and IDs) stay exact. */
export function structuredDetailLabel(key: string): string {
  const words = key.replace(/([A-Z]+)([A-Z][a-z])/gu, "$1 $2")
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/[_-]+/gu, " ").trim();
  return words ? words[0]!.toUpperCase() + words.slice(1) : "Unnamed field";
}

export interface StructuredDetailsProps extends HTMLAttributes<HTMLDivElement> {
  readonly value: ConversationStateJsonValue;
}

/** Deterministic presentation of already-authorized data; never parses markup,
 * infers units, hides fields or substitutes a summary for the reviewed values. */
export function StructuredDetails({ value, className, ...props }: StructuredDetailsProps): ReactNode {
  return <div {...props} className={["hr-details", className].filter(Boolean).join(" ")}>
    <DetailValue value={value} depth={0}/>
  </div>;
}

/** Presentation budget, not a data limit. Expanded reviews always retain every value. */
export function shouldCollapseStructuredDetails(value: ConversationStateJsonValue): boolean {
  let rows = 0;
  let characters = 0;
  let lines = 0;
  function visit(item: ConversationStateJsonValue, depth: number): boolean {
    if (++rows > 8 || depth > 4) return true;
    if (item !== null && typeof item === "object") {
      const entries = Array.isArray(item) ? item.map(value => ["", value] as const) : Object.entries(item);
      for (const [key, child] of entries) {
        characters += key.length;
        if (characters > 800 || visit(child, depth + 1)) return true;
      }
    } else {
      const text = String(item ?? "");
      characters += text.length;
      lines += text.split("\n").length - 1;
    }
    return characters > 800 || lines > 8;
  }
  return visit(value, 0);
}

export interface StructuredDetailsDisclosureProps extends StructuredDetailsProps {
  readonly summary?: ReactNode;
  /** Keep a disclosure for short reviews as well. */
  readonly always?: boolean;
  /** Override the initial state; user toggles survive polling/rerenders. */
  readonly defaultOpen?: boolean;
}

/** Generic SDK review/result presentation. Use StructuredDetails inside host-owned disclosures. */
export function StructuredDetailsDisclosure({ value, summary = "Details", always = false, defaultOpen,
  ...props }: StructuredDetailsDisclosureProps): ReactNode {
  const [chosenOpen, setChosenOpen] = useState<boolean | null>(null);
  const large = shouldCollapseStructuredDetails(value);
  if (!always && !large) return <StructuredDetails {...props} value={value}/>;
  return <details className="hr-details-disclosure" open={chosenOpen ?? defaultOpen ?? !large}
    onToggle={event => setChosenOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    <StructuredDetails {...props} value={value}/>
  </details>;
}

function DetailValue({ value, depth }: { readonly value: ConversationStateJsonValue; readonly depth: number }): ReactNode {
  if (value === null) return <span className="hr-details__empty">Not set</span>;
  if (Array.isArray(value)) {
    return value.length === 0 ? <span className="hr-details__empty">No items</span>
      : <ol className={`hr-details__list${depth >= 4 ? " hr-details__list--flat" : ""}`}>{value.map((item, index) =>
        <li key={index}><DetailValue value={item} depth={depth + 1}/></li>)}</ol>;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value);
    return entries.length === 0 ? <span className="hr-details__empty">No fields</span>
      : <dl className="hr-details__fields">{entries.map(([key, item]) =>
        <div key={key} className={`hr-details__field${item !== null && typeof item === "object" ? " hr-details__field--group" : ""}${depth >= 4 ? " hr-details__field--flat" : ""}`}>
          <dt>{structuredDetailLabel(key)}</dt><dd><DetailValue value={item} depth={depth + 1}/></dd>
        </div>)}</dl>;
  }
  if (value === "") return <span className="hr-details__empty">Empty text</span>;
  return <span className="hr-details__value">{typeof value === "boolean" ? value ? "Yes" : "No" : String(value)}</span>;
}

/** Included in handrailChatPresetCss; headless DOM consumers can bundle it too. */
export const HANDRAIL_STRUCTURED_DETAILS_CSS = `
.hr-details-disclosure{min-inline-size:0;max-inline-size:100%}.hr-details-disclosure>summary{cursor:pointer;overflow-wrap:anywhere}.hr-details-disclosure[open]>.hr-details{margin-block-start:.65rem}
.hr-details{min-inline-size:0;max-inline-size:100%;overflow-wrap:anywhere;white-space:normal;line-height:1.5}
.hr-details__fields{display:grid;gap:.65rem;margin:0;padding:0}
.hr-details__field{display:flex;flex-wrap:wrap;gap:.2rem 1rem;min-inline-size:0}
.hr-details__field>dt{flex:0 1 9rem;font-size:.9em;font-weight:600;color:var(--hr-muted,inherit)}
.hr-details__field>dd{flex:1 1 15rem;min-inline-size:0;margin:0}
.hr-details__field--group{display:block}.hr-details__field--group>dt{margin-block-end:.35rem}
.hr-details__field--group>dd{border-inline-start:2px solid var(--hr-border,currentColor);padding-inline-start:.75rem}
.hr-details__list{display:grid;gap:.65rem;margin:0;padding-inline-start:1.5rem}.hr-details__list>li{min-inline-size:0;padding-inline-start:.2rem}
.hr-details__field--flat>dd{border:0;padding:0}.hr-details__list--flat{padding:0;list-style-position:inside}.hr-details__list--flat>li{padding:0}
.hr-details__value{white-space:pre-wrap;overflow-wrap:anywhere}.hr-details__empty{color:var(--hr-muted,inherit);font-style:italic}
`;
