# Testing Guide

This guide defines the validation baseline for ClawAll runtime safety, governance behavior, and on-chain enforcement.

## Automated Validation

### 1) Install

```bash
npm install
```

### 2) Test Suite

```bash
npm test
```

Expected:

- Security and policy-path tests pass
- Tamper/freeze behavior is enforced
- Audit fail-closed behavior is validated

### 3) JavaScript Syntax Check

```bash
for f in $(find src tests -name '*.mjs'); do node --check "$f" || exit 1; done
```

### 4) Move Build

```bash
cd chain/sui
sui move build
```

Expected:

- Build succeeds
- Core entry points compile (constraint minting, policy hash set, freeze toggle, transfer execute)

## Manual Validation Matrix

| Scenario | Action | Expected Result |
|---|---|---|
| Normal transfer | Demo option `1` | Executes unless freeze active |
| Medium risk | Demo option `2` | Governance approval path engaged |
| High risk | Demo option `3` | Approval required |
| OS attack simulation | Demo option `4` | Blocked by firewall; freeze behavior visible |
| Tamper simulation | Demo option `9` | Blocked + frozen at integrity/anchor verification layer |
| Forensics bundle | Demo option `8` | Bundle generated under `src/state/forensics/` |
| Audit unavailable | Disable Walrus path and execute transfer | Blocked at `AUDIT` layer |
| On-chain freeze | Trigger freeze then execute transfer | Transfer fails on-chain |

## Governance Validation

Prepare `.env` with:

- `TG_BOT_TOKEN`
- `TG_CHAT_ID`
- `TG_OPERATOR_IDS` and/or `TG_OPERATOR_USERNAMES`

Run `npm run demo` and verify:

1. Non-allowlisted users cannot approve/reject.
2. Non-allowlisted users cannot execute governance commands.
3. Allowlisted users can approve/reject and resume.
4. Log and proof commands return expected outputs.

## Split-Custody Validation

### Runtime Session

- Ensure `POLICY_CAP_ID=` is empty.
- Run runtime flow (`npm run demo` or gateway path).

### Policy-Admin Session

```bash
POLICY_CAP_ID=<policy_admin_cap_id> npm run policy:setup-once
npm run policy:freeze -- --reason="test"
npm run policy:unfreeze -- --reason="test_done"
```

Expected:

- Runtime cannot mutate policy anchor without admin authority.
- Runtime continues enforcing integrity and anchor verification gates.

## Tamper Resistance Validation

### Policy Tamper

1. Trigger tamper simulation (demo option `9`).
2. Confirm blocked result (`POLICY_INTEGRITY` or `POLICY_ANCHOR`).
3. Confirm frozen state via status path.

### Cap Isolation

1. Set `POLICY_CAP_ID` in runtime env.
2. Trigger any protected path.
3. Confirm `CAP_ISOLATION` block and freeze.

## Evidence for Submission

Generate artifacts:

```bash
npm run benchmark:redteam
npm run forensics:bundle
```

Expected outputs:

- `src/state/red-team-benchmark.json`
- `src/state/forensics/<bundle-id>/bundle.json`
- `src/state/forensics/<bundle-id>/bundle.md`
