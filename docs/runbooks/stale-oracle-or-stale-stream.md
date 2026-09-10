# Stale Oracle Or Stale Stream

## Symptoms

- duel phase or HP data stops updating
- quotes remain open around lock/resolve boundaries
- lifecycle status lags real duel outcomes

## Detection

```bash
curl -fsSL "$KEEPER_URL/status" | jq '.parsers, .stream'
curl -fsSL "$KEEPER_URL/api/streaming/state" | jq
curl -fsSL "$KEEPER_URL/api/arena/prediction-markets/active" | jq
curl -fsSL "$KEEPER_URL/api/keeper/bot-health" | jq
```

## Immediate Containment

1. Stop the dedicated Solana duel bot so the affected market cannot receive new quotes or privileged lifecycle writes.
2. Treat stale oracle or stale stream as higher priority than preserving uptime.
3. Do not resolve markets manually unless lifecycle state is confirmed from authoritative chain state.

## Recovery Steps

1. Confirm whether the failure is upstream stream data or chain/oracle freshness.
2. Restore stream/oracle input first.
3. Restart the keeper if it does not reconcile automatically.
4. Re-check canonical lifecycle state and bot-health freshness timestamps.
5. Re-enable quoting only after stale markers clear and lifecycle state matches chain state.

## Success Criteria

- stream state updates again
- lifecycle records move out of stale or unknown state
- quote state remains disabled during stale input and resumes only after recovery

## Escalation

Escalate if:

- stale input persists beyond the expected upstream recovery window
- markets remain open through lock or resolve boundaries
- settlement occurs from stale data

## Evidence To Capture

- latest stream payload
- `/status` parser and stream fields
- `/api/keeper/bot-health` freshness fields
- exact timestamps of last good update
