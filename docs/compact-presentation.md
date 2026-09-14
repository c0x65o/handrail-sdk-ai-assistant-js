# Compact shared assistant presentation

The styled assistant uses 13px message text, 12px history controls, compact card
padding, and a Threads menu by default. `historyLayout="sidebar"` remains an
explicit option for hosts that have room for persistent history. The menu is
bounded by the chat header, so a narrow drawer inside a wide desktop page stays
contained. Embedded page layouts fill their host without imposing a viewport
width or a 480px minimum height.

Font family and font size are separate CSS declarations. A host using
`theme={{ fontFamily: "inherit" }}` must inherit the host's typeface without
invalidating the size declaration and falling back to the host's larger text.
History also sets its own size rather than inheriting a page-level font size.
The composer retains 16px input text and at least 44px icon controls on touch
devices.

Mills, Spartan, and Hitcents select compact history in their integrations. Host
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
