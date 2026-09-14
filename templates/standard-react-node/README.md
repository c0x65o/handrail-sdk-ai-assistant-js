# Standard React + Node assistant scaffold

This is a complete, compilable React/Express host shell. The SDK supplies the
assistant routes, conversation catalog/history, uploads/downloads, approvals,
send/retry/Stop, dictation, usage and default UI. The host connects trusted
authentication, business tools/policy, PostgreSQL and provider configuration.

## Install and build

Use the declared Node engine and npm 12.0.2 or newer. The `packageManager` and
`devEngines` fields make an older toolchain fail early. npm 10/11 may rewrite a
GitHub HTTPS dependency to SSH in the lockfile; npm 12 includes the
[upstream HTTPS resolution fix](https://github.com/npm/pacote/releases/tag/v22.0.0).
Use the corrected package manager rather than editing resolved dependency URLs.
The included `.npmrc` allows only root-declared Git dependencies. `allowScripts`
permits compilation of the exact SDK Git revision and esbuild's binary setup; additional
dependency scripts remain subject to npm's default review policy.

```sh
npm install --include=dev
npm run check
```

The scaffold resolved public SDK HEAD to a full Git SHA (or honored the explicit
`--sdk-revision`). `npm install` generates the matching `package-lock.json` and
compiles the SDK through its normal Git `prepare` hook. Keep that lock with the
manifest. Subsequent clean builds use `npm ci --include=dev`. Do not replace the
SDK with a registry, tarball, local path, workspace, branch or tag dependency.
Scaffolding itself performs no dependency installation or database writes.

The package includes optional styled UI peers and the application's framework,
database driver and build tooling. A host with an existing framework can copy
`src/assistant` and use its existing driver/build pipeline instead.

## Connect the application

1. Implement `src/assistant/host/identity.ts` using the application's current
   authenticated session on every request. Resolve tenant/user scope on the
   server, enforce assistant permission and CSRF/origin policy, and return SDK
   attribution. Its default returns `host_auth_not_configured` and grants no
   access. No development login, trusted-header shortcut or tenant default is
   shipped. Wire `browser-auth.ts` to the application's CSRF accessor; the
   example reads a `csrf-token` meta element from the authenticated page.
2. Supply server configuration from declared runtime resources. `.env.example`
   lists this example's OpenAI adapter fields; it is not loaded automatically.
   `npm run doctor` reports missing keys without printing values or making
   database/provider requests. Replace the provider assembly if using another
   SDK provider. The server uses the SDK's structured diagnostic logger, which
   omits private error causes from ordinary logs. Handrail's attached usage capability is read automatically by
   `usageFromEnvironment`; do not invent extra Handrail resource requirements.
3. Apply `npm run db:migrate` only against an authorized database through the
   application's migration workflow. It uses the SDK's idempotent PostgreSQL
   schema setup. It does not import or purge old chats. Production database
   approval still applies; this command must never substitute for it.
4. Add domain tools and policy in `host/tools.ts`. The default has no tools and
   denies execution. Preserve financial authorization and required review on the
   server; UI approval preferences do not grant permission.
5. Run `npm start` after building. The server mounts the SDK at `/api/assistant`
   before body parsers so JSON, files and audio all reach the shared adapter.
   The UI uses `HandrailAssistantLauncher` with standard controls. Customize
   branding through its supported theme/slots. Connect shutdown to the host's
   request/worker drain, call `stopAssistant`, then close the database pool.

New history needs the schema and a stable trusted tenant/scope. Missing provider
configuration is separate from authentication or persistence. Do not mask an
unauthorized or failed history read as an empty conversation list.

## Qualify the integration

`npm run check` compiles both typed source and the production client/server.
Run the SDK adoption checker for static package/source signals; it is not runtime
conformance. Verify authenticated capabilities, 401/403 and ownership isolation,
new/select/reopen, send/reload, uploads, approvals, restart/recovery and usage in
the actual host. Check microphone/voice on authorized target devices rather than
inferring audio success from build or local fake-provider tests.

The scaffold compiles against its public SDK pin; it cannot adopt unpublished
SDK cleanup/features automatically. Deployed legacy removal and remote file
retention require the separately authorized cutover for that application.
