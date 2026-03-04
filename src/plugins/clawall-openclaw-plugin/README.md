# ClawAll OpenClaw Plugin

OpenClaw plugin integration for ClawAll gateway-backed security and transfer workflows.

## Purpose

This plugin exposes ClawAll status, wallet, pricing, and signed transfer routes to OpenClaw through deterministic commands and natural-language routing.

## Start Gateway

From repository root:

```bash
npm run gateway
```

Default endpoint: `http://127.0.0.1:3011`

## Install Plugin

```bash
openclaw plugins install ./src/plugins/clawall-openclaw-plugin
```

Restart OpenClaw after install.

## Exposed Methods

- `clawall.status`
- `clawall.check`
- `clawall.signed_transfer`
- `clawall.wallet`
- `clawall.price`

## Slash Commands

- `clawall_status`
- `clawall_check`
- `clawall_wallet`
- `clawall_price`
- `clawall_snapshot`
- `clawall_transfer`
- `clawall_transfer_quote`

## Natural Language Examples

- `send 0.0023 hasui to 0x...`
- `send 0.034 sui and 0.0034 wal to 0x...`
- `send 0.0034 hawal to 0x... and 0.34 usdc and show wallet balance`
- `send 0.0324 sui to 0x... and show exact usd value`
- `show me price of sui and my wallet balance`

## CLI Equivalents

- `openclaw clawall status`
- `openclaw clawall check`
- `openclaw clawall transfer --amount <base_units> [--recipient <0x...>]`
- `openclaw clawall transfer-quote --amount <base_units|sui> [--recipient <0x...>]`
- `openclaw clawall wallet`
- `openclaw clawall price --coin-type <0x...::module::struct> [--amount <base_units>]`

## Plugin Configuration

`~/.openclaw/openclaw.json` example:

```json
{
  "plugins": {
    "entries": {
      "clawall-security": {
        "enabled": true,
        "config": {
          "api_url": "http://127.0.0.1:3011",
          "api_key": "<same as CLAWALL_PLUGIN_KEY>"
        }
      }
    }
  }
}
```

## Transfer Route Protection

`/v1/signed-transfer` is plugin-key gated using `CLAWALL_PLUGIN_KEY`.

- Missing/invalid key -> `401 unauthorized`
- Plugin sends `x-clawall-plugin-key` from `api_key`

This prevents direct signed-transfer bypass when properly configured.

## Required Environment

- `PRIVATE_KEY`
- `GUARD_CAP_ID`
- `FREEZE_STATE_ID`
- `PACKAGE_ID`
- `RPC_URL`
- `CLAWALL_PLUGIN_KEY`
- `CLAWALL_ENFORCE_PLUGIN_GATE=1`
