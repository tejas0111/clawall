# ClawAll

ClawAll is a security and governance runtime for autonomous OpenClaw agents on Sui.  
It enforces policy decisions before execution and applies on-chain constraints to reduce fund-drain and privilege-escalation risk.

## Project Links

- Repository: https://github.com/tejas0111/clawall
- Documentation: https://clawall.netlify.app/docs.html
- Demo: https://clawall.netlify.app/#demo-video
- Setup: https://clawall.netlify.app/#setup-video
- Architecture Diagram: https://clawall.netlify.app/assets/diagrams/architecture-main.svg

## Core Capabilities

- Intent firewall for OS, browser, and blockchain actions.
- Risk engine with policy outcomes (`ALLOW`, `BLOCK`, `REQUIRE_APPROVAL`).
- Governance approval gate for risky operations.
- Policy integrity checks and optional on-chain policy anchor verification.
- Move-level transfer constraints and freeze controls on Sui.
- Audit-first execution with Walrus logging.
- OpenClaw plugin support for command and NL-driven workflows.

## Architecture Summary

```text
Intent
  -> Intent Firewall
  -> Risk Engine
  -> Policy Engine
  -> Governance Approval
  -> Integrity/Anchor Verification
  -> On-Chain Constraint Execution
  -> Audit Logging
```

## Repository Structure

- `src/orchestrator/` - intent orchestration and runtime pipeline
- `src/chain/` - Sui transaction gateway and chain interactions
- `chain/sui/sources/` - Move enforcement contracts
- `src/governance/` - governance bot and approval handlers
- `src/enforcement/` - policy integrity and anchor tooling
- `src/plugins/clawall-openclaw-plugin/` - OpenClaw plugin integration
- `src/openclaw/dashboard-local.mjs` - local dashboard server/proxy
- `src/local/dashboard/dashboard.html` - local dashboard UI

## Prerequisites

- Node.js 20+
- npm
- Sui CLI
- OpenClaw CLI/runtime
- Testnet-funded wallets for setup and runtime testing

## Quick Start

1. Install dependencies.

```bash
npm install
```

2. Configure `.env` (minimum required variables).

```env
PACKAGE_ID=<sui_package_id>
RPC_URL=https://fullnode.testnet.sui.io:443
PRIVATE_KEY=<runtime_private_key>
GUARD_CAP_ID=<guard_cap_id>
FREEZE_STATE_ID=<freeze_state_id>
CLAWALL_PLUGIN_KEY=<plugin_key>
CLAWALL_ENFORCE_PLUGIN_GATE=1
POLICY_INTEGRITY_MODE=strict
POLICY_ANCHOR_MODE=strict
POLICY_CAP_ID=
```

3. Run setup.

```bash
npm run setup
```

4. Start runtime services.

```bash
npm run dashboard
```

## Common Commands

- `npm run gateway` - start ClawAll gateway
- `npm run dashboard` - start local dashboard
- `npm run demo` - run interactive demo shell
- `npm run setup` - full all-in-one setup
- `npm run topup` - vault top-up flow
- `npm test` - run test suite
- `npm run forensics:bundle` - generate forensics bundle

## Security Model

- Split-custody is required:
  - Runtime authority for operations (`GuardCap` path).
  - Separate admin authority for policy/governance updates.
- Runtime must not hold policy admin capability.
- Fail-closed behavior is expected when integrity, anchor, audit, or freeze checks fail.

## License

See repository license and project terms in source control.
