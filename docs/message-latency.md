# Message submission and streaming latency

The display session previously waited for pending storage and history reads
before showing the submitted message. React also waited for post-admission
history reads before clearing the accepted draft. Flutter already had an
outgoing-message row, but created it only after its preflight refresh.

Both SDK sessions now expose local outgoing feedback before their first await,
using the same message identity that will be submitted. React renders this row
outside canonical history, follows it even in an empty conversation, and removes
it when that exact saved message arrives. Delivery remains explicitly sending,
sent, or unconfirmed. A failed preflight removes the preview; a definitive
rejection preserves the editable draft. Saved submission IDs and durable draft
cleanup still govern admission and retries. React acceptance notification and
provider startup no longer wait for a full post-admission history refresh.

Streaming had a server bottleneck independent of Markdown rendering: each tiny
provider text frame required a durable turn write, then canonical projection,
before consumption continued. The standard server now groups consecutive text
frames into bounded batches of at most 64 with a 16 ms collection window. The
canonical projector also appends consecutive text frames together. These are
batched writes, not synthesized or rewritten protocol events: every original
frame, sequence, fingerprint, and resume checkpoint remains available. Tool,
approval, and terminal events form barriers. A quiet stream flushes partial text;
a failed stream keeps its valid prefix. Concurrent projectors reconcile message
IDs after a revision conflict.

Regression checks cover 64 tiny text frames using one canonical append, 140
frames using three durable writes, replay deduplication, competing projectors,
quiet/failed streams, ordering barriers, delayed send preflight, double-send
suppression, immediate React rendering/following, and failed-send recovery.
These are network-free correctness and write-count checks, not production
latency measurements.

This change is in SDK source. Consumer applications retain their committed HTTPS
Git SHA dependencies and matching lockfiles. Adoption requires a committed SDK
revision followed by application builds; no deployment is implied.
