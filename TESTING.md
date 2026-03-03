# Testing Guide

This guide is optimized for hackathon verification and judge walkthroughs.

## 1) Automated checks

### Install

```bash
npm install
```

### Unit/integration tests

```bash
npm test
```

Expected:

- 4 test files pass
- includes policy gates, tamper freeze, audit fail-closed behavior, and benchmark thresholds

### Syntax check

```bash
for f in $(find src tests -name '*.mjs'); do node --check "$f" || exit 1; done
```

### Move build

```bash
cd chain/sui
sui move build
```

Expected:

- Build success
- `mint_constraint`, `set_policy_hash`, `set_global_freeze`, `execute_transfer` compile

## 2) Critical manual test matrix

| Test | Action | Expected |
|---|---|---|
| Normal transfer | Demo option `1` | Executed (unless frozen) |
| Medium risk | Demo option `2` | Governance approval path engaged |
| High risk | Demo option `3` | Approval required in Telegram |
| OS attack | Demo option `4` | Blocked by firewall; freeze behavior visible |
| Tamper simulation | Demo option `9` | Blocked + frozen at integrity/anchor layer |
| Forensics | Demo option `8` | Bundle generated under `src/state/forensics/` |
| Audit unavailable | Break Walrus config + run transfer | Blocked at `AUDIT` layer |
| On-chain freeze | `policy:freeze` then demo option `1` | Transfer fails on-chain |

## 3) Telegram governance checks

Prepare `.env` with:

- `TG_BOT_TOKEN`
- `TG_CHAT_ID`
- `TG_OPERATOR_IDS` and/or `TG_OPERATOR_USERNAMES`

Run `npm run demo` and validate:

1. Non-allowlisted user cannot approve/reject callback.
2. Non-allowlisted user cannot run `/freeze`, `/resume`, `/releaseq`.
3. Allowlisted operator can approve/reject and `/resume`.
4. `/logs`, `/oslogs`, `/chainlogs`, `/tx`, `/bundle` return expected content.

## 4) Split-custody validation

### Runtime session

- `POLICY_CAP_ID=` must be empty.
- Start demo with `npm run demo`.

### Policy-admin session

- Run one-time setup:

```bash
POLICY_CAP_ID=<policy_admin_cap_id> npm run policy:setup-once
```

- Toggle on-chain freeze:

```bash
npm run policy:freeze -- --reason="test"
npm run policy:unfreeze -- --reason="test_done"
```

Expected:

- Runtime cannot update policy anchor without policy-admin cap.
- Runtime still enforces anchor/integrity checks.

## 5) Tamper resistance checks

### Policy tamper

1. Run demo option `9`.
2. Observe `BLOCKED` with `POLICY_INTEGRITY` or `POLICY_ANCHOR`.
3. Confirm frozen state with option `5`.

### Cap isolation

1. Temporarily set `POLICY_CAP_ID` in runtime env.
2. Trigger any intent.
3. Expect `CAP_ISOLATION` block and freeze.

## 6) Evidence artifacts for submission

Generate before final submission:

```bash
npm run benchmark:redteam
npm run forensics:bundle
```

Expected files:

- `src/state/red-team-benchmark.json`
- `src/state/red-team-benchmark.md`
- `src/state/forensics/<bundle-id>/bundle.json`
- `src/state/forensics/<bundle-id>/bundle.md`

