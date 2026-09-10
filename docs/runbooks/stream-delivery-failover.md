# Stream Delivery Failover

This procedure covers the public Hyperbet HLS player and its explicitly
reviewed ordered sources. It does not authorize a new provider, destination,
DNS change, deployment, or transaction. The production source order, recovery
time objective, incident owners, and provider-specific fault method must be
approved and recorded before rehearsal.

## Stop conditions

Do not start or continue a rehearsal when:

- the environment is production or carries real value;
- any source could show different video, audio, timing, or duel identity;
- a URL is being copied from an unapproved location or contains credentials in
  its authority component;
- the approved observer, provider owner, rollback owner, or evidence location
  is absent;
- the transaction-disabled staging/preview boundary is not independently
  confirmed;
- inducing failure could delete media, rotate an unrecorded secret, affect an
  unrelated stream, or require an unrehearsed production change.

Remain fail closed and escalate instead of improvising around any stop
condition.

## Required approved inputs

Record these outside the repository in the protected release record:

- release SHA and deployment URL;
- Solana cluster and expected genesis hash;
- ordered primary and backup HLS sources, with one owner per source;
- proof that every source carries the same encoded program-date-aligned output;
- provider-specific safe fault and restore procedures;
- maximum source-switch and full-recovery times;
- maximum acceptable HLS program-date lag in milliseconds;
- minimum approved rendition count and maximum acceptable program-date skew
  between renditions;
- exact public browser origin and maximum approved live-manifest cache lifetime;
- incident commander, stream operator, Hyperbet observer, rollback owner, and
  escalation channel;
- protected evidence destination and retention/access policy.

Do not put signed URL query values, ingest credentials, bearer tokens, cookies,
wallet material, RPC keys, or provider secrets in a ticket, terminal transcript,
screenshot, or evidence file.

## Read-only source preflight

Load `HYPERBET_SOLANA_STREAM_SOURCES` through the approved secret/environment
mechanism; do not paste a signed source into shell history. Its order must be
identical to the deployed `VITE_STREAM_SOURCES` order.

From the exact release checkout, create a new evidence pathname and run:

```bash
bun run pm:stream:failover:verify -- \
  --interval-ms=6000 \
  --timeout-ms=10000 \
  --max-program-date-lag-ms="$APPROVED_STREAM_LAG_MS" \
  --max-rendition-program-date-skew-ms="$APPROVED_RENDITION_SKEW_MS" \
  --minimum-variant-count="$APPROVED_MINIMUM_RENDITIONS" \
  --browser-origin="$APPROVED_BROWSER_ORIGIN" \
  --max-manifest-cache-seconds="$APPROVED_MANIFEST_CACHE_SECONDS" \
  --output="$FAILOVER_EVIDENCE_PATH"
```

The verifier reads every configured source without downloading media segments.
It accepts a direct media playlist or validates every rendition in an HTTPS
master playlist, then requires a later observation of every rendition to
advance media sequence, program date, and segment identity. It rejects a
missing, malformed, unsafe, duplicated, excessive, stagnant, or unexpectedly
changed rendition; an undersized ladder; timestamps outside the approved lag
bound; and rendition edges outside the approved program-date skew. It supports
one to three unique HTTPS `.m3u8` sources and up to eight variants per master,
requires the exact public browser origin through both CORS and
`Timing-Allow-Origin`, requires a recognized HLS MIME type, rejects immutable or
overlong live-manifest caching, redacts query parameters from the retained
evidence, hashes only redacted source and segment identities, bounds manifest
size and request duration, creates a mode-0600 evidence file, and refuses to
overwrite an existing file.

Any source failure blocks the rehearsal. A successful preflight does not prove
decoded audio/video, media-segment delivery policy, source equivalence,
automatic switching, or recovery time.

## Transaction-disabled staging rehearsal

1. Confirm the release SHA, devnet identity, `VITE_TRANSACTIONS_ENABLED=false`,
   configured source order, and public deployment URL from independent release
   evidence. Do not rely on a label in the page.
2. Run the read-only preflight and preserve its output hash.
3. Open one isolated test browser. Confirm decoded video time advances, audio is
   present, the program-date-aligned duel telemetry matches the frame, and the
   public application reports the primary source. Confirm no wallet signing
   surface is available.
4. Using only the approved provider-specific non-destructive method, have the
   source owner make the primary unavailable. Record the exact UTC fault time.
5. Confirm the player visibly enters recovery, does not present stale playback
   as live, switches to the next configured source once, and restores advancing
   decoded video plus program-date alignment within the approved bound. Record
   source index, switch time, recovery time, console/network failures, and any
   frozen or black frames.
6. Restore the primary through the approved procedure. Do not force an
   immediate switch during healthy backup playback unless the approved product
   policy requires it.
7. Repeat for every configured backup. Then make every source unavailable in
   the approved order and prove the player starts a bounded new recovery round
   at the primary rather than remaining permanently on the last failed source.
8. Restore the primary and confirm one clean recovery with no duplicate player,
   audio, timer, or telemetry subscription. Re-run the read-only preflight.
9. Close only the isolated test browser/profile and stop only resources created
   for this rehearsal. Confirm no owned listener or test browser remains.

## Production incident containment

1. Declare a stream incident and record the last known good decoded playback and
   program-date timestamps. Never expose signed query parameters in incident
   evidence.
2. Confirm authoritative Hyperia stream health, capture/encoder health, public
   HLS delivery, Hyperbet public stream state, and keeper readiness separately.
   A green manifest response alone is not playback authority.
3. If public playback authority is absent, require the application to keep new
   transaction authority disabled. Preserve existing on-chain market and
   terminal custody; do not synthesize a result or modify the keeper database.
4. If quote containment is required, follow
   [SOL quote disablement and safe restart](quote-disablement-and-safe-restart.md).
   If the incident is an upstream stale feed rather than delivery only, also
   follow [stale oracle or stale stream](stale-oracle-or-stale-stream.md).
5. Permit the preconfigured player to advance through its bounded source order.
   Do not hot-edit a signed URL, source order, DNS target, or Pages environment
   during the incident without the approved change and rollback procedure.
6. If every source fails or source equivalence cannot be proven, remain stopped
   for new betting and escalate. Stream uptime never outranks duel identity,
   settlement integrity, or user-fund safety.

## Recovery criteria

- every configured source and every advertised rendition passes the read-only
  advancing-manifest, freshness, minimum-count, alignment, CORS, timing, MIME,
  and live-cache verifier;
- the public browser has advancing decoded video and audio with a finite,
  advancing program date aligned to the canonical duel;
- source order and the active source match the approved deployment record;
- renderer, capture, encoder, delivery, public stream state, keeper, and market
  health are fresh and mutually consistent;
- transaction authority is restored only under the separately approved release
  procedure;
- no duplicate playback, audio, telemetry subscription, market, order, result,
  refund, claim, or terminal operation was created;
- before/fault/recovery evidence, exact timings, release identity, observers,
  approvals, and cleanup results are retained.

## Launch evidence

The launch package must include the mode-0600 verifier artifact and SHA-256,
redacted deployment configuration, browser recording, source-switch timeline,
console/network export with secrets removed, health snapshots, exact recovery
measurements, operator identities, approvals, and cleanup audit. A repository
unit test or synthetic local HLS source is not production failover evidence.
