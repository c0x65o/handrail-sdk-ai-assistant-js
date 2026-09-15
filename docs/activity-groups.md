# Inline request activity

The React styled preset now renders one expandable activity card in the transcript
for each request. Previously, tool activity and the response status lived in rows
above the composer; Aegis further replaced the details with a bare count.

The card shows thinking, running tools, writing, waiting for approval, stopped,
failed, or completed activity. Tool continuations share a stable root identity;
starting another request does not move or erase earlier tool activity. Canonical
history reconstructs the groups on reload. Expansion survives live updates and
continuations; reload starts collapsed. Details contain readable names and lifecycle
statuses, including recorded recovery, without tool arguments or raw results.
Approval cards and domain results remain separate transcript entries with their
existing decision controls and authorization.

`toolActivity` still accepts collapsed, expanded and hidden. Hidden keeps live
response status but omits tool details. `renderToolActivity` now supplies content
inside the expanded request group. Hosts should omit it for the standard list.
Headless `ConversationTranscript` accepts `includeActivity` and `renderActivity`;
`conversationActivityGroups` is exported for custom renderers.

The shared user-message margin reset also no longer overrides right alignment.
The browser fixture checks this along with narrow/wide geometry, bounded details,
keyboard expansion, writing/completion updates, and draft preservation.

## Candidate and adoption

This is uncommitted source on JS SDK fef136a2085be2c33d6117a5055fbd99a8b966e5
(0.2.44). Earlier single-conversation work remains in the same checkout. Its prior
candidate hashes are historical and do not identify this combined candidate.
Aegis source on ccb65593e2e4e996e4ab74249b4f08e530abdb0c removes its custom count
override. Its manifest/lock and installed SDK still resolve to fef136a2085be2c33d6117a5055fbd99a8b966e5,
which does not contain these new groups. No dependency pin or installed package was
replaced, and no release was performed.

After publication is authorized, publish the reviewed SDK changes to public Git,
freeze the resulting full SHA, update consumer HTTPS Git pins and matching locks,
install/build normally, rerun the actual consumer UI checks, and deploy only with
release authorization. Verify authenticated streaming, refresh and approval flows
on that release. Rollback uses the previous host release plus its matching locked
SDK revision; this presentation change requires no database migration.

Validation and inspected synthetic browser captures for this change are retained
in the Spartan repository at docs/qa/inline-activity-groups. This is React candidate
qualification, not live deployment, provider execution, or Flutter qualification.
