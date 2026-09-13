# SDK repository boundaries

This repository owns the JavaScript/TypeScript SDK, React presentation, server
adapters and the application gateway wire protocol.

Flutter source was extracted into the declared sibling repository
`../handrail-sdk-ai-assistant-flutter`, under `packages/handrail_ai_client` and
`packages/handrail_ai_widgets`. Make Flutter changes and run Flutter checks there;
do not recreate a `flutter/` source tree in this repository. The new repository's
README and Makefile describe its setup and checks. Its gateway integration tests
install this JS SDK using a locked public HTTPS Git commit.

Consumer adoption requires a published full Git SHA from the correct repository
and a matching package-manager lockfile. Existing old JS-repository Dart pins
continue to resolve their historical source; removing the current Flutter tree
does not update an application dependency.
