# Standard scaffold qualification

The source CLI generates a complete React/Express/TypeScript project. Its
authentication seam returns `host_auth_not_configured` until the host connects
trusted session, tenant, permission and CSRF checks. Domain tools default to an
empty, denied set. The SDK owns the gateway, catalog, canonical history,
attachments, approvals, usage and standard controls. Hosts configure supported
provider/storage inputs and business authorization.

The generated `db:migrate` command calls SDK persistence setup explicitly. It
never runs on server startup, imports old chats or purges production data. The
normal Handrail production database approval requirement still applies.

## Reproduce the clean setup check

Use the declared Node engine and npm 12.0.2 or newer. npm 12 includes the
[pacote HTTPS Git resolution fix](https://github.com/npm/pacote/releases/tag/v22.0.0).
The scaffold's `.npmrc` enables root-declared Git dependencies; its manifest
permits the SDK `prepare` and esbuild setup scripts. SDK compilation remains in
normal dependency installation, with no SDK packaging/publication step.

```sh
node /path/to/sdk/scripts/adopt.mjs scaffold /tmp/new-assistant-host
cd /tmp/new-assistant-host
npm install --include=dev
npm run check
npm ci --include=dev
npm run check
node /path/to/sdk/scripts/adopt.mjs check /tmp/new-assistant-host
```

Scaffolding resolves the latest public committed SHA once. For a previously
agreed frozen revision, add `--sdk-revision <40-character-sha>` to the scaffold
command. Neither branch/tag dependencies nor temporary source aliases qualify.
After installation, the root lock specification and installed node's `resolved`
URL/SHA must exactly match the manifest, including the installed hidden lock at
`node_modules/.package-lock.json`. npm 10 can leave the checked-in lock unchanged
while rewriting that installed resolution to SSH. The template and CLI are
available in public JS revision `5a0ebe520a9e6fde0b3a792f959a7a10e0a3de50`.

The generated doctor checks configuration syntax and required names without
printing their values or contacting the database/provider. The server uses SDK
structured diagnostics that omit private causes from normal logs. Wire a
separate access-controlled diagnostic sink if the host needs those causes.

## Database and runtime fixture

After a clean build, this repository's fixture uses the generated server
composition and **that project's installed public SDK**, without local aliases:

```sh
node /path/to/sdk/scripts/check-scaffold-install.mjs /tmp/new-assistant-host
```

It requires a local PostgreSQL 15 toolchain (override only its executable
directory with `SDK_POSTGRES_TEST_BIN`). It creates and removes its own isolated
cluster and accepts no project database URL. It runs the generated migration
twice, tests fail-closed auth through real Express, then supplies fixture-only
identity, provider and telemetry seams. It checks 401/403, cross-user and tenant
isolation, create/send, permission revocation, canonical history after a new
server/pool/client, archive/restore and usage recovery after an outage. Cleanup
closes its clients, HTTP listeners, usage workers and pools before removing the
owned cluster. Fixture auth is never copied into the generated host.

## Published baseline qualification

Public revision `5d9387c1a07b4b131cbc65ce273a5d1f6faf035b` (0.2.35) installed
and compiled but intermittently failed during first send. A deterministic
PostgreSQL regression exposed the cause: at READ COMMITTED, a concurrent append
could appear in a separate head query without appearing in the earlier event
page, creating a false history gap. The SDK now reads both in one SQL statement.

Public revision `5a0ebe520a9e6fde0b3a792f959a7a10e0a3de50` (0.2.36) includes
that correction. A newly generated scaffold pinned to this exact SHA passed
fresh `npm install`, typed client/server and production build, clean `npm ci`,
the same build gates and the static adoption check using Node 22.23.1/npm 12.0.2.
SDK compilation ran during normal Git dependency preparation. Manifest, checked-in
lock, installed hidden lock, package version and real installed paths were checked;
no local SDK aliases or packaging/publication steps were used.

The native PostgreSQL fixture then passed fresh/repeated migration, fail-closed
auth, authenticated create/send, user/tenant isolation, permission revocation and
usage capture during an outage. A new server/pool/client recovered canonical
history, archive/restore and queued usage without re-executing the synthetic
provider. It recorded one provider call and one usage receipt. All owned clients,
listeners, pools and the disposable cluster were stopped and removed. This
supersedes the earlier pending-public-history-fix dependency; it does not claim
that every consumer or real provider has been qualified.

Fixture: `/tmp/handrail-clean-scaffold-217786b0-9-public`.
Logs: `/tmp/sdk-public-5a-scaffold-{install,check,ci,ci-check,adoption,runtime,lint}.log`.
The runtime checker now also asserts the installed lock and package identity so
an HTTPS root lock cannot hide npm 10's SSH rewrite. That fixture-only assertion
is a new local change; the application SDK used for this run was the public pin.

The fixture does not establish live provider execution, audio playback, mobile
presentation, full deletion/retention, financial tool authorization or deployed
consumer adoption. Those require the shared acceptance suite and each host's
authorized runtime qualification. The new local in-memory deletion-receipt
correction and Flutter reviewed-deletion implementation are separate adoption
dependencies; they are not included in this public JS baseline.
