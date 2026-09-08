# Standard React + Node assistant scaffold

Move these files into the host source tree and implement only the referenced
`./host/*` seams. Mount `assistant.express({ origin })` behind the application's
existing authenticated route, invoke `stopAssistant()` during graceful
shutdown, apply the SDK Postgres migrations, and run the conformance checker.

The scaffold intentionally contains no credentials, tenant selection, domain
tools, or application database policy. Those stay owned by the host.

The web host installs the SDK optional UI peers `react-markdown@^10.1.0` and
`remark-gfm@^4.0.1` alongside React; the SDK owns Markdown/GFM configuration.
