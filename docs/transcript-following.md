# Transcript following

The standard React preset and `HandrailAssistantLauncher` manage transcript
scrolling automatically. Each selected conversation starts at its latest message,
including switching back to an already loaded conversation with the same revision.
Streaming text, delayed image/Markdown layout, composer growth, and viewport
resizing keep the latest message visible while following is enabled.

An upward wheel, touch, keyboard, or scrollbar movement pauses following, even
within the bottom proximity threshold. Content arriving while paused leaves the
reader's position alone. Scrolling downward to the bottom or choosing **Jump to
latest** resumes following. Explicit jumps respect reduced motion preferences;
automatic following and thread changes are immediate.

Headless integrations use the same hook on the element that actually scrolls:

```tsx
const follow = useSmartTranscriptFollow({
  conversationId: state.conversation_id,
  contentVersion: state,
});

return <div className="transcript-wrap">
  <div className="transcript" ref={follow.transcriptRef}
    onScroll={follow.onScroll} tabIndex={0}
    role="region" aria-label="Conversation transcript">
    {messages}
  </div>
  {!follow.following && <button type="button"
    onClick={() => follow.scrollToLatest()}>
    {follow.hasNewContent ? "New messages" : "Jump to latest"}
  </button>}
</div>;
```

Constrain the scrollport's height (`min-height: 0` inside flex/grid parents), set
`overflow: auto`, and prevent flex message children from shrinking. Use
`overflow-anchor: none` so browser anchoring does not compete with following, and
`overscroll-behavior-y: contain` to keep transcript gestures inside the panel.
Position the jump button outside the scrollable content so it remains reachable
without changing transcript height. The hook observes the viewport and its direct
children, watches inserted/changed content, and releases observers, listeners, and
queued animation frames when detached. A naturally sized content wrapper supports
late layout changes without requiring a separate content ref.

Pass a stable `contentVersion` that changes with rendered conversation content;
do not create a new object on every render. `conversationId` resets follow state
independently of this version. Integrations supporting an older SDK without that
option can key the conversation component by conversation ID to reset its hook.

## Workspace qualification, 2026-09-07

This source patch is uncommitted. Mills' standard preset inherits the SDK fix;
Spartan's host patch replaces its post-render distance check with this shared
hook, keys conversation instances, and supplies a constrained scrollport and jump
control. Both npm consumers still pin SDK commit
`74369d2116601b25a6d6367a745ff92c42d0812a`. A new SDK commit and the corresponding
HTTPS Git SHA/lockfile upgrades are required for the full shared behavior in those
applications. No copied SDK, dependency override, package archive, commit, push,
or deployment is part of this patch.

Validation passed:

- SDK `npm run typecheck` and `npm run build`.
- SDK transcript, styled preset, and launcher suites: 41 tests, one worker.
  Eleven scrolling regressions cover large appends, matching-revision thread
  switches, small upward wheel gestures, touch/keyboard reading, interrupted
  smooth jumps, delayed content, resizing, reduced motion, and Strict Mode cleanup.
- Spartan's UI, transcript DOM, attachment, and voice suites: 30 tests, one worker,
  against both the installed SHA and the locally compiled candidate. Candidate
  resolution used a temporary test configuration; manifests, lockfiles, and
  installed dependency files were not changed.
- Spartan's scoped `tsconfig.handrail-ai-qualification.json` compile.
- Chromium fixtures using the actual Mills preset/theme and Spartan scrollport
  styles at widths 390 and 1280: initial bottom placement, large appends, pausing
  within five pixels, thread switches, composer growth/shrink, delayed content
  insertion and resize, jump, keyboard reading, and hidden-panel reopening.
  Final bottom gaps were zero and no browser errors occurred. Browsers were
  closed in `finally` cleanup. These were isolated UI fixtures with synthetic
  conversation data, not authenticated app or Flutter Mobile Preview sessions.

Concurrent edits to conversation loading and navigation were present during
qualification and were preserved. This document describes the scrolling changes.
