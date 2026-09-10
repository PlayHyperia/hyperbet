# Duel Dispute Evidence Runbook

This runbook covers collection, independent offline verification, retention handoff, and retrieval of the SOL-only duel dispute package. It is a technical procedure, not approval of a duel result, release classification, retention duration, or access policy.

## Stop conditions

Do not collect or label a package release-eligible when any of these are true:

- the exact terminal operation is not durably `SUCCEEDED`
- the oracle or market account is not terminal at finalized commitment
- the retained feed lacks the immutable competitive snapshot or material phase timeline
- the duel, participant, timing, result, program, transaction, source, binary, or IDL identities disagree
- either source tree is dirty for a release candidate
- the production storage, retention, access, legal-hold, and reviewer approvals are absent

The collector and verifier fail closed on the technical conditions. Operators remain responsible for the external approvals and for never changing diagnostic classifications to release classifications by hand.

## Collect before validator or RPC history teardown

Run from the repository root after the exact duel has reached durable terminal success. `SOLANA_RPC_URL` must be supplied through the approved secret-injection path; never paste a keyed RPC URL into a ticket, evidence bundle, or shell transcript.

```sh
bun run --cwd packages/hyperbet-solana/keeper duel-dispute-evidence -- \
  --db-path /approved/runtime/terminal-ledger.sqlite \
  --duel-id exact-duel-id \
  --output /approved/evidence/duel-dispute-evidence.json \
  --cluster localnet
```

Use the truthful cluster and classification flags for the environment. The default is diagnostic localnet with no external value, no production-equivalent infrastructure, and no release eligibility. Production collection must use the exact release binaries, IDLs, source revisions, database, program IDs, and finalized RPC history. The collector creates one canonical mode-0600 file and refuses to overwrite an existing destination.

Record the emitted artifact SHA-256, package digest, duel ID, duel key, classification, and transaction count in the release evidence index. Do not edit, reformat, rename in place, or regenerate a package to hide a failed verification.

## Independent offline verification

Transfer the artifact and the expected hashes/identity through separately controlled channels. On a clean reviewer checkout, run without an RPC, database, wallet, or signing key:

```sh
bun run --cwd packages/hyperbet-solana/keeper duel-dispute-evidence:verify -- \
  --input /review/evidence/duel-dispute-evidence.json \
  --artifact-sha256 expected-64-character-sha256 \
  --package-digest expected-64-character-package-digest \
  --duel-id exact-duel-id \
  --duel-key expected-64-character-duel-key \
  --cluster localnet
```

For a production release review, add `--require-release-eligible`. That flag must fail until the package itself truthfully records mainnet-beta, external value, production-equivalent infrastructure, clean Hyperia and Hyperbet trees, and release eligibility. A successful command proves canonical bytes, the self-hash, internal semantic consistency, expected identity/classification, and exact reviewer-supplied hashes. It does not independently prove that the chain, source repository, object store, or policy owner supplied truthful inputs.

The reviewer must separately compare:

- Git revisions and every retained source-file hash to clean release checkouts
- program IDs, loader ownership, ProgramData, upgrade authority, SBF hashes, and IDL hashes to deployment evidence
- each retained signature and transaction digest to an approved archival RPC or independently retained ledger source
- oracle and market terminal state to finalized chain evidence
- artifact storage version, object-lock/legal-hold state, access log, and retention metadata to the approved policy

## Retention handoff

Before production, the launch owner must record the approved immutable storage provider and location, object-lock mode, retention duration, deletion/legal-hold rules, encryption and key ownership, allowed reader/writer roles, replication policy, access logging/alerting, archival RPC retention, and recovery owner. Missing values block release; this runbook deliberately does not invent them.

The handoff must retain:

- the canonical JSON artifact and both digests
- the release evidence index entry and independent verifier output
- the clean source revisions and dependency/toolchain lock evidence
- the exact SBF/IDL artifacts and deployment identity evidence
- the archival transaction source and retrieval metadata
- named collector and reviewer approvals with timestamps

No private key, bearer token, keyed URL, wallet secret, or unredacted secret-manager output belongs in the package or its index.

## Retrieval and dispute drill

At the approved drill interval, select a retained package without warning the operator, retrieve it through the documented least-privilege path, verify its object version and expected artifact hash, run the offline verifier with every expected identity, and repeat the independent source/program/chain comparisons above. Record retrieval time, verification result, access-log event, reviewer, failures, escalation, and recovery time.

Any missing object, hash mismatch, noncanonical payload, semantic verification failure, unexpected classification, unavailable chain history, source/program mismatch, or unauthorized access is a launch blocker or incident. Preserve the original bytes and logs, stop affected settlement or release activity through the separately approved emergency procedure, and escalate to Security, Operations, and the designated dispute owner. Never repair the evidence file in place.
