# Compact shared assistant presentation

The styled assistant uses 13px message text, 12px history controls, compact card
padding, and a visible conversation sidebar by default. On small screens the
history sits above the conversation. `historyLayout="compact"` is an explicit
option for hosts that need a Threads menu. That optional menu is
bounded by the chat header, so a narrow drawer inside a wide desktop page stays
contained. Embedded page layouts fill their host without imposing a viewport
width or a 480px minimum height.

Font family and font size are separate CSS declarations. A host using
`theme={{ fontFamily: "inherit" }}` must inherit the host's typeface without
invalidating the size declaration and falling back to the host's larger text.
History also sets its own size rather than inheriting a page-level font size.
The composer retains 16px input text and at least 44px icon controls on touch
devices.

Mills, Spartan, and Hitcents select visible history in their integrations. Host
CSS should own branding, application headers, and custom domain content; shared
history, transcript, and composer density belongs here. Applications that bundle
`handrailChatPresetCss` and `HANDRAIL_CHAT_COMPOSER_CSS` receive the same rules as
applications using `StyledChatPresetStyles`.

Validation: build the SDK, then run `node scripts/check-assistant-layout.mjs`.
It checks persistent history at four viewport widths and compact menus embedded
in 300–980px panels inside a wide viewport, including an enlarged host font and
touch controls. `HANDRAIL_TEST_CHROMIUM` can select an installed browser and
`HANDRAIL_ASSISTANT_SCREENSHOT_DIR` retains screenshots.

Consumer adoption requires publishing the SDK commit, then updating each app's
public HTTPS Git dependency to that full commit SHA and regenerating its lockfile.
An uncommitted SDK patch has no publishable revision; local source validation does
not update the apps' pinned SDK installations or deployed assets.

September 14 host source changes use the existing sidebar option from the
installed public JS revision `f22d13721d32a04bef44a65be189ac8da07ce2e1`.
Cents and Aegis use 960×720 maximum panels, 16px desktop insets and 8px phone
insets. Cents' backdrop rule must outrank the shared modal centering rule.
Mills' drawer is up to 960px wide. Mills' web live button starts directly;
captions and ended-call history are optional disclosures. Actual calls still
use its protected gateway, admission/recovery checks and existing business tools.
Hitcents has no live-call server route yet; adding a visual button alone does not
provide live voice. This remains separate unfinished backend integration.
