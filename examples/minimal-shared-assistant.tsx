import { HandrailAssistantLauncher, type HandrailAssistantLauncherProps } from "@handrail/ai-assistant/react/styled";

/** The endpoint authorizes identity, domain tools and attachments. The SDK owns
 * history, composer, approval preference, authenticated dictation and uploads. */
export function MinimalSharedAssistant({ accountId, endpoint, protectedRequest }: {
  readonly accountId: string;
  readonly endpoint: string;
  readonly protectedRequest: NonNullable<HandrailAssistantLauncherProps["protectedRequest"]>;
}) {
  return <HandrailAssistantLauncher key={accountId} endpoint={endpoint} protectedRequest={protectedRequest}
    title="Assistant" defaultApprovalMode="required" maxPromptCharacters={2000}
    theme={{ colors: { accent: "#aa4d2a" }, fontFamily: "inherit" }}/>;
}
