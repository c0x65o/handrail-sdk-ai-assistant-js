import type { ApplicationGatewayAction } from "@handrail/ai-assistant";
import type { HandrailAssistantAuthorizationContext } from "@handrail/ai-assistant/server/assistant";

export type AssistantContext = HandrailAssistantAuthorizationContext;

/** The required application seam. Resolve the existing authenticated session on
 * every request; enforce its current permissions and your CSRF/origin policy.
 * Return server-trusted tenantId, scopeId, principalId and attribution. Never
 * select a tenant/user from an unauthenticated header, query or JSON body.
 * Keep opaque session credentials in memory; do not persist recovery tokens. */
export async function authorizeAssistantRequest(
  _request: Request, _action: ApplicationGatewayAction,
): Promise<AssistantContext> {
  void [_request, _action];
  // Replace this fail-closed seam with the application's existing authentication.
  throw new Response(JSON.stringify({ ok: false, error: {
    code: "host_auth_not_configured", message: "Assistant authentication is not configured.", retryable: false,
  } }), { status: 503, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
