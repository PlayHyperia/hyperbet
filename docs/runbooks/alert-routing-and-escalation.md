# Streaming Alert Routing And Escalation

This procedure covers the authoritative Hyperia streaming-runtime alert route
used by the SOL-only duel and Hyperbet experience. It does not select an alert
provider, incident owner, escalation schedule, response objective, or alert
threshold. Those values must be approved and retained in the protected release
record before external value is enabled.

The server requires an explicit alert route, route identity, monitor interval,
reminder interval, retry interval, and request timeout whenever
`HYPERIA_EXTERNAL_VALUE_ENABLED=true` on a production streaming authority. A
replica must not hold the streaming webhook. This keeps one elected authority
responsible for pages and prevents every game-server replica from emitting the
same incident.

## Stop conditions

Do not enable external value or continue a rehearsal when:

- the release SHA, environment, authority role, or route identity is ambiguous;
- the webhook is not an approved HTTPS destination or appears in a replica;
- a primary responder, backup responder, escalation path, or witnessed test
  window has not been approved;
- monitor, reminder, retry, or timeout values have not been explicitly approved;
- a test event could be mistaken for a real incident or the receiving team has
  not agreed to the test;
- secrets would be copied into shell history, screenshots, logs, tickets, or
  evidence files;
- the public experience, canonical duel feed, keeper, or on-chain state is
  already unhealthy.

Remain fail closed with `HYPERIA_EXTERNAL_VALUE_ENABLED=false`. Do not invent a
temporary responder, silently route to a general webhook, or weaken production
validation to make startup pass.

## Required approved inputs

Record these outside the repository in the protected release record:

- full release SHA, environment, deployment identity, and Solana cluster;
- the elected authority service and confirmation that replicas do not receive
  `STREAMING_ALERT_WEBHOOK_URL`;
- approved `STREAMING_ALERT_ROUTE_ID` and the alert-system destination owner;
- approved monitor, reminder, retry, and timeout values;
- primary responder, backup responder, incident commander, escalation channel,
  acknowledgement objective, and recovery owner;
- maintenance/suppression procedure and an independent rollback owner;
- protected evidence destination, retention policy, and access policy.

Load `STREAMING_ALERT_WEBHOOK_URL` through the approved secret mechanism. Do not
pass it as a command-line argument. The checked-in probe deliberately retains no
webhook URL, response body, header, token, or credential.

## Configuration preflight

On the exact release candidate, confirm the authority has all of:

```text
NODE_ENV=production
STREAMING_DUEL_SCHEDULER_ROLE=authority
HYPERIA_EXTERNAL_VALUE_ENABLED=true
STREAMING_ALERT_WEBHOOK_URL=<approved-secret-destination>
STREAMING_ALERT_ROUTE_ID=<approved-lowercase-route-id>
STREAMING_HEALTH_MONITOR_INTERVAL_MS=<approved-value>
STREAMING_ALERT_REMINDER_MS=<approved-value>
STREAMING_ALERT_RETRY_MS=<approved-value>
STREAMING_ALERT_TIMEOUT_MS=<approved-value>
```

The production process must fail before serving if an external-value authority
lacks any value, the URL is not HTTPS, the route ID is malformed, the timing is
out of bounds, the timeout exceeds the monitor interval, or retry exceeds the
reminder interval. Confirm every replica lacks the streaming webhook. A general
`ALERT_WEBHOOK_URL` is not a production fallback for this route.

## Explicit route probe

Coordinate the test window with the receiving team. Use a new evidence path and
the exact full release SHA. The explicit approval environment variable is a
guard for this single test invocation; it is not permission for any other
external action.

From the Hyperia repository root:

```bash
STREAMING_ALERT_TEST_APPROVED=true \
  bun run --cwd packages/server stream:alert:probe -- \
  --environment="$DEPLOYMENT_ENVIRONMENT" \
  --release-sha="$RELEASE_SHA" \
  --timeout-ms="$APPROVED_ALERT_TIMEOUT_MS" \
  --output="$ALERT_PROBE_EVIDENCE_PATH"
```

The command emits one `STREAMING_RUNTIME_ALERT_TEST` event marked
`actionRequired: false`, refuses redirects, requires a successful HTTPS
response, creates mode-0600 evidence, and refuses to overwrite existing
evidence. It sends no transaction and changes no duel, market, wallet, stream,
or chain state.

HTTP acceptance proves only that the webhook endpoint accepted the event. It
does not prove alert-platform ingestion, routing, paging, human receipt, or
escalation. The evidence therefore records
`deliveryScope: webhook_http_acceptance_only` and
`onCallAcknowledgementRequired: true`.

## Witnessed route and escalation proof

1. Have the designated observer record the probe ID and exact UTC send time.
2. Require the alert platform to show the same probe ID, route ID, environment,
   release SHA, test classification, and non-actionable status without exposing
   the webhook or another secret.
3. Require the primary responder to acknowledge through the approved platform.
   Record the platform incident/event ID and measured delivery and
   acknowledgement times outside the repository evidence artifact.
4. Exercise the approved backup/escalation path in the isolated staging route.
   Do not suppress or reassign a production route merely to make the rehearsal
   pass.
5. Confirm a recovery/test close does not create a second incident, and confirm
   the route returns to its approved steady state.
6. Remove only temporary test suppression or resources created by the approved
   procedure. Reconfirm that replicas have no streaming webhook.

Any missing, duplicated, delayed beyond the approved bound, misrouted, or
secret-bearing event fails the rehearsal.

## Runtime alert behavior

The authority observes scheduler authority, betting feed, renderer, capture,
encoder, live audio, stream delivery, keeper health, stale scheduler phases,
and increases in dropped-frame counters. It sends a firing notification when
the normalized issue set changes, retries failed webhook acceptance, emits
approved-interval reminders while the same issue remains, and sends recovery
only after a previously delivered issue set clears.

Payloads use bounded normalized reason codes. Arbitrary runtime strings, URLs,
and credentials are replaced by an unclassified code. A failed dropped-frame
notification remains pending until it is accepted; the observed counter is not
acknowledged early.

On a real firing alert:

1. Acknowledge and declare the incident under the approved policy.
2. Correlate the route ID, firing time, release, authority holder, runtime health
   snapshot, public player state, keeper state, and canonical duel/market state.
3. Prevent new external-value exposure whenever authoritative render, stream,
   oracle, keeper, or identity health cannot be proven. Preserve user cancel,
   claim, refund, and terminal recovery paths.
4. Follow the specific containment procedure for
   [stale oracle or stale stream](stale-oracle-or-stale-stream.md),
   [stream delivery failover](stream-delivery-failover.md), or
   [quote disablement and safe restart](quote-disablement-and-safe-restart.md).
5. Do not treat a recovery notification alone as permission to reopen. Apply
   the complete runbook recovery criteria and independent approval.

## Launch evidence

Retain the mode-0600 probe artifact and SHA-256, alert-platform event/incident
identity, redacted route configuration, authority/replica environment audit,
delivery and acknowledgement measurements, primary and backup responder proof,
escalation result, exact release/cluster identity, observers, approvals, and
cleanup audit. Repository tests and webhook HTTP acceptance are necessary but
do not replace a witnessed staging and production-route rehearsal.
