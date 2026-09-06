# Standard composer qualification — 2026-09-06

Scope: AI Chatbot group — Handrail AI Assistant SDK, Mills Family Office (web and mobile), Spartan Cyber ERP (web and mobile). Existing unrelated Spartan mobile edits were preserved.

The previous layouts came from independent application markup and theme overrides. React now shares StandardChatComposer; Flutter shares handrail_ai_widgets. Reference renders at 320, 390, and 768 pixels show the draft above the toolbar, no horizontal overflow, and controls at least 44 pixels wide. Native layout tests use the same widths and enforce toolbar alignment; native controls are 48 logical pixels.

## Candidate identity

Both web repositories install the same immutable local artifact: handrail-ai-assistant-0.2.12-composer.29d8b2a23982.tgz. Artifact hashes, lockfile integrity, and every distributed JavaScript/declaration file were compared to the built SDK. Both mobile repositories contain matching widget sources with per-file SHA-256 provenance. No registry publication, commit, push, pull request, or production deployment was performed.

## Validation

- SDK: TypeScript check, build, scoped ESLint; 44 composer/styled/approval/voice tests pass (43 initially, then 18 focused tests including the added default PDF-intake case).
- Shared Flutter widgets: analysis and four tests pass, covering three widths and the approval switch.
- Mills web: TypeScript, scoped ESLint, and 42 runtime/voice/gateway/mutation tests pass.
- Mills mobile: scoped analysis and 74 screen/repository tests pass.
- Spartan web: TypeScript, scoped ESLint, and 22 UI/composition/approval-policy tests pass.
- Spartan mobile: scoped analysis passes; 26 of 27 screen/repository tests pass. The read-acknowledgement test "reload observes two running threads and cancellation waits for server state" also fails with untouched HEAD source and test: it expects reads for two threads but observes none. The changed retained-request retry test passes and preserves automatic mode across recreation.
- Both native permission manifests parse successfully. Native device microphone, OS clipboard integration, Android packaging, and iOS signing/build have not been exercised on physical devices in this Linux runner.

A new PDF-intake test fixture initially recreated its uploader on every render, causing a loop and approximately 1.1 GiB worker RSS. The command guard recorded 1340 MiB peak memory, zero swap and zero OOM kills; the worker was deliberately terminated with SIGTERM (exit 143), the fixture corrected to retain its uploader, and all 18 focused tests passed. This was not an observed app failure or OOM.

## Mobile Preview evidence

Used Handrail's authorized dev Mobile Preview proxy and private helper with the same-project QA Vault profile; no direct Flutter listener was used. Initially the preview/backend services were stopped. After starting the declared dev services, the proxy served the Flutter sign-in screen (HTTP 200). The authorized login POST /api/v1/auth/login returned HTTP 500; the matching request log showed ECONNREFUSED to a local backend dependency. The diagnostic tool's generic no-failure summary was based on a separate unauthenticated probe and did not reproduce that login request. The browser was closed in finally. No credentials, handoffs, HAR, or authenticated screenshots are retained in this report.

This blocks verification of the signed-in composer through Mobile Preview; it is not evidence of a composer defect. The PNGs here are isolated renders of the built shared React composer with a sample draft, not screenshots of an authenticated application. The new source applies after the updated SDK and host code are rebuilt/reloaded together; production and installed mobile builds require their normal release process.
