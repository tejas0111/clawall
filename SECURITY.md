# Security Policy

ClawAll applies fail-closed controls for autonomous agent execution on Sui. This document defines security objectives, trust boundaries, required controls, and incident handling.

## Security Objectives

ClawAll is designed to enforce the following invariants:

1. No protected transfer executes unless policy and audit gates pass.
2. Medium/high-risk actions require governance approval.
3. Policy tampering triggers freeze before execution.
4. Runtime and policy-admin authority remain split (no shared custody).
5. Transfer limits are enforced on-chain by Move constraints.

## Trust Model

### Trusted Operators

- Allowlisted operators (`TG_OPERATOR_IDS`, `TG_OPERATOR_USERNAMES`)
- Runtime holder of `GuardCap` for constraint-minted execution
- Policy-admin holder of `PolicyAdminCap` for anchor/freeze governance

### Partially Trusted Infrastructure

- Telegram transport
- Sui RPC infrastructure
- Walrus availability

### Untrusted Inputs

- Agent-generated intents
- External content (prompt/web/email)
- Non-allowlisted users and callback payloads

## Control Stack

### Runtime Controls

- Intent firewall for malformed/dangerous actions
- OS policy firewall (command/path/egress restrictions)
- Prompt quarantine with explicit operator release
- Sequence firewall for suspicious cross-domain behavior
- Risk scoring and policy decisioning
- Governance approval gate for elevated-risk actions
- Kill-switch persistence and containment behavior

### Integrity Controls

- Signed policy verification (`POLICY_INTEGRITY_MODE`)
- On-chain anchor hash verification (`POLICY_ANCHOR_MODE`)
- Runtime cap isolation guard (`ENFORCE_CAP_ISOLATION=1`)

### On-Chain Controls (Move)

- Recipient binding
- Amount cap
- Expiry window validation
- Metadata bounds checks
- `GlobalFreeze` check inside transfer execution

### Audit Controls

- Walrus proposal upload required before execution
- Fail-closed behavior on audit write failure
- OS security mirroring to Walrus Quilt (best effort)

## Threat Outcomes

| Scenario | Expected Outcome |
|---|---|
| Destructive OS command | Blocked by firewall; may trigger freeze |
| High-risk transfer | Approval required |
| Walrus write failure | Blocked at `AUDIT` layer |
| Policy tamper without re-sign | Blocked + frozen (`POLICY_INTEGRITY`) |
| Anchor mismatch | Blocked + frozen (`POLICY_ANCHOR`) |
| Runtime has `POLICY_CAP_ID` | Blocked + frozen (`CAP_ISOLATION`) |
| On-chain freeze active | Transfer aborts on-chain |

## Deployment Requirements

### Mandatory Split Custody

- Runtime wallet: operational authority only (`GuardCap` path)
- Policy-admin wallet: governance authority (`PolicyAdminCap`)
- Runtime `.env` must keep `POLICY_CAP_ID=` empty

### Mandatory Runtime Configuration

- `POLICY_INTEGRITY_MODE=strict`
- `POLICY_ANCHOR_MODE=strict`
- `ENFORCE_CAP_ISOLATION=1`
- `FREEZE_STATE_ID=<global_freeze_object_id>`

## Incident Response

1. Engage freeze (`/freeze` and/or policy freeze command).
2. Stop runtime-facing execution paths.
3. Audit `/chainlogs`, `/tx`, `/oslogs`, and proof artifacts.
4. Rotate compromised keys/secrets.
5. Re-verify integrity, anchor, and test matrix.
6. Resume only after operator validation.

## Vulnerability Reporting

Do not disclose exploitable details publicly.

Report privately with:

- Impact and affected component
- Reproduction steps
- Relevant evidence/logs
- Proposed mitigation (if available)
