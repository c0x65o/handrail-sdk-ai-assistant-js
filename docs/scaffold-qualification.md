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
URL/SHA must exactly match the manifest. The current CLI can be run from this
source checkout; consumers do not receive these template changes until release.

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

**Known release dependency:** public revision
`5d9387c1a07b4b131cbc65ce273a5d1f6faf035b` (`0.2.35`) installs and compiles, but
the runtime fixture intermittently fails during first send. Source inspection
and a deterministic PostgreSQL regression exposed a non-atomic page/head read:
at READ COMMITTED, a concurrent append can appear in the second head query but
not the first event page, creating a false history gap. The source now returns
both from one SQL statement. The native regression failed before that change
and passes afterward. A public pin containing that correction and a new clean
runtime qualification are still required; successful intermittent runs are not
accepted as completion. Do not disable recovery or substitute a local alias to
hide this adoption dependency.

The fixture does not establish live provider execution, audio playback, mobile
presentation, full deletion/retention, financial tool authorization or deployed
consumer adoption. Those require the shared acceptance suite and each host's
authorized runtime qualification. Unpublished cleanup APIs are likewise absent
from the existing public pin.
