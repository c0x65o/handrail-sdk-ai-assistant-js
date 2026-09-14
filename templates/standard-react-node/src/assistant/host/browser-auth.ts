/** Connect this to the existing application's CSRF token accessor. The server
 * must validate it against the current authenticated session. Never put provider
 * credentials, tenant selection or server permission decisions in this module. */
export function protectedAssistantRequest(input: RequestInit & { readonly url: string }): RequestInit {
  const headers = new Headers(input.headers);
  const token = document.querySelector<HTMLMetaElement>('meta[name="csrf-token"]')?.content;
  if (token) headers.set("x-csrf-token", token);
  return { ...input, headers, credentials: "same-origin" };
}
