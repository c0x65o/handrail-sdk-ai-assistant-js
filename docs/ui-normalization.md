# Assistant UI normalization — September 14, 2026

This is a local source handoff. No commits, SDK publication, dependency updates,
deployments or production writes were performed in this pass. Preserve the
existing approval/lifecycle cleanup changes alongside these presentation edits.

## Changes

| Surface | Local behavior |
| --- | --- |
| Shared React workspace | Visible history by default; compact Threads menu remains explicit opt-in. |
| Cents web | Visible history; 960×720 maximum panel docked bottom-right with 16px desktop / 8px phone insets. Specific backdrop selector prevents global modal styles from recentering it. |
| Aegis web | Same panel sizing and insets, visible history, sizing survives either stylesheet order. |
| Mills web | Drawer widened from 560px to 960px maximum. Visible history. Start live voice invokes the existing call directly; captions and previous calls start collapsed. Active captions can still refresh after reaching the current end. |
| Cents mobile | Safe-area-aware header, readable 16px text/input, no duplicate context or single-mode bar. Removed invisible corner listeners covering Close. Routine counter hidden; the installed SDK's overlength explanation remains available. |
| Mills mobile | Composer respects the bottom safe area and keyboard. Routine counter hidden. Voice surface has one Start live voice action; optional shared-speaker choice, captions and ended-call history are collapsed. Unfinished-call recovery and saved business reviews remain available. |
| Aegis mobile | Routine counter hidden using the existing shared workspace option. |
| Shared Flutter workspace | Routine counter defaults off; an overlong draft still gets an explanation and remains editable. |

Native phones retain the shared SDK's history picker, with a sidebar on wider
screens. Web phones show the history above the conversation. No new host chat
engine or send/approval controller was added. Host branding remains distinct.

## Validation

- Cents web: 13 component tests and browser typecheck passed. Actual host UI,
  installed SDK and synthetic protected gateway passed desktop/phone light/dark
  flows, right/bottom geometry, history, send/Stop, draft preservation, rich
  results, protected attachment download and CSP checks.
- Mills web: 22 component tests and scoped qualification typecheck passed.
  Browser fixture passed 390/1280px drawer sizing, visible history, one-click
  microphone invocation with synthetic permission denial, collapsed reviews,
  keyboard expansion and draft/composer preservation. No provider call occurred.
- Aegis web: scoped UI typecheck passed. Actual shell CSS passed four viewport
  sizes with both stylesheet orders.
- Cents mobile: 20 workspace tests, six updated/current visual baselines and
  seven navigation/close/route restoration tests passed.
- Aegis mobile: 13 SDK screen tests passed.
- Mills mobile: voice/route tests and protected gateway tests passed; keyboard
  and bottom-safe-area cases cover 320px and 402px screens.
- JS SDK: 35 styled/history tests and typecheck passed.
- Flutter SDK: 12 workspace tests passed, including overlength feedback with
  the default counter hidden. Scoped Flutter analysis passed for all changed
  application and SDK sources.

## Remaining work and rollout

Hitcents has dictation but **no live-call backend route**. A working web/mobile
live button still needs shared protected SDP/bootstrap and end routes, durable
call recovery, authorized domain tools/approval handoff, history/activity and
usage integration. Do not expose a fake live button, copy a second host runtime,
or treat a transcription microphone as live conversation. This backend work is
unfinished, not a missing UI/environment flag.

Mills production Mobile Preview was rejected with
`preview_browser_access_denied`: the project is outside this Dev Chat's saved
preview scope. No browser was opened through that route and no app failure was
reproduced. Synthetic fixtures and widget tests do not verify microphone/audio
playback on a device or real provider execution.

Hosts still install JS `f22d13721d32a04bef44a65be189ac8da07ce2e1` and Flutter
`7ef5795a823b282ee53dc08951ada1817be11c24` from the public HTTPS Git repositories.
The host edits use supported APIs in those pins. New SDK defaults require a
published full commit SHA and matching consumer locks before adoption. No local
alias or edited installed dependency was used. Production remains unchanged;
overall UI/voice parity and the blocked cleanup goal are not complete.
