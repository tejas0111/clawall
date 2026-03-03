# Security Policy

This document defines ClawAll's security model, trust boundaries, and operational controls.

## 1) Security objectives

ClawAll is designed to enforce the following invariants:

1. No blockchain transfer executes without passing policy and audit gates.
2. High-risk actions require explicit human governance approval.
3. Policy tampering triggers freeze before execution.
4. Runtime host cannot safely hold policy-admin capability.
5. Transfer bounds are enforced on-chain by Move.

## 2) Trust model

### Trusted operators

- Allowlisted Telegram operators (`TG_OPERATOR_IDS`, `TG_OPERATOR_USERNAMES`)
- Holder of `GuardCap` for runtime constraint minting
- Holder of `PolicyAdminCap` for policy anchor and global freeze administration

### Partially trusted infrastructure

- Telegram API transport
- Sui fullnode RPC
- Walrus publisher/aggregator availability

### Untrusted inputs

- Agent-generated intent payloads
- Prompt/web/email external content
- Non-allowlisted users interacting with bot endpoints

## 3) Control stack

### Runtime controls

- Intent firewall for malformed or dangerous actions
- OS policy firewall (command/path/egress constraints)
- Prompt quarantine with explicit operator release
- Sequence firewall for cross-domain suspicious behavior
- Risk engine + policy engine
- Telegram approval for medium/high risk paths
- Kill-switch persistence and cross-domain containment

### Integrity controls

- Policy signature verification (`POLICY_INTEGRITY_MODE`)
- On-chain policy hash anchor verification (`POLICY_ANCHOR_MODE`)
- Runtime cap isolation guard (`ENFORCE_CAP_ISOLATION=1`)

### On-chain controls (Move)

- Recipient binding
- Amount cap
- Expiry check
- Metadata bounds checks
- `GlobalFreeze` state check inside `execute_transfer`

### Audit controls

- Walrus proposal upload required before execution
- Fail-closed behavior when audit write fails
- OS security event mirroring to Walrus Quilt (best effort)

## 4) High-risk scenarios and outcomes

| Scenario | Expected outcome |
|---|---|
| Agent submits destructive OS command | Blocked at firewall; may trigger freeze |
| Agent submits high-risk transfer | Requires human approval |
| Walrus audit write fails | Transfer blocked (`AUDIT` layer) |
| Policy files changed without re-signing | Blocked + frozen (`POLICY_INTEGRITY`) |
| On-chain policy hash mismatches local policy | Blocked + frozen (`POLICY_ANCHOR`) |
| Runtime accidentally has `POLICY_CAP_ID` | Blocked + frozen (`CAP_ISOLATION`) |
| On-chain freeze set by policy-admin | Transfer aborts on-chain |

## 5) Deployment requirements

### Mandatory split custody

- Runtime wallet: owns `GuardCap` only.
- Policy-admin wallet: owns `PolicyAdminCap` and `GlobalFreeze`.
- Runtime `.env` must have empty `POLICY_CAP_ID`.

### Mandatory runtime configuration

- `POLICY_INTEGRITY_MODE=strict`
- `POLICY_ANCHOR_MODE=strict`
- `ENFORCE_CAP_ISOLATION=1`
- `FREEZE_STATE_ID=<global_freeze_object_id>`

## 6) Incident response

1. Engage freeze (`/freeze` and/or `policy:freeze`).
2. Rotate compromised secrets.
3. Review `/chainlogs`, `/tx`, `/oslogs`, `/osproof`.
4. Generate forensic bundle (`npm run forensics:bundle`).
5. Patch and verify (`npm test`, `sui move build`).
6. Resume only after human validation (`/resume` or `policy:unfreeze`).

## 7) Security issue reporting

Do not disclose exploitable vulnerabilities publicly.

Report privately with:

- Impact and affected path
- Repro steps
- Evidence/logs
- Suggested mitigation (if available)
