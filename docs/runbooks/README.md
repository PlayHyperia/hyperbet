# Hyperbet Solana Runbooks

These are the operator procedures for the Solana-only v1 launch.

- [Local Hyperia integration](hyperia-local-pm-integration.md)
- [Prediction-market test flow](prediction-market-test-flow.md)
- [Confidence soak](pm-confidence-soak.md)
- [Staged live proof](staged-live-proof.md)
- [Governance and emergency controls](prediction-market-governance-and-emergency-controls.md)
- [Signer policy and rotation](signer-policy-and-key-rotation.md)
- [Quote disablement and safe restart](quote-disablement-and-safe-restart.md)
- [Stale oracle or stale stream](stale-oracle-or-stale-stream.md)
- [Chain outage or RPC degradation](chain-outage-or-rpc-degradation.md)
- [Stuck market recovery](stuck-market-recovery.md)
- [Claim and refund availability recovery](claim-backlog-drainage.md)
- [Stream delivery failover](stream-delivery-failover.md)
- [Streaming alert routing and escalation](alert-routing-and-escalation.md)
- [Backup, restore, and release rollback](backup-restore-and-release-rollback.md)
- [Cold-authority pause and duel cancellation](cold-authority-pause-and-cancel.md)
- [Oracle finality fail-closed](oracle-finality-fail-closed.md)

Use the [release-readiness contract](../prediction-market-release-prep.md) and the canonical cross-repository launch checklist for promotion decisions. Never use a runbook to bypass a failing readiness dependency.

Every procedure in this directory is restricted to the Solana duel-only launch topology. A command for a retired service, alternate chain, or noncanonical database is a release-blocking documentation defect, not an optional fallback.
