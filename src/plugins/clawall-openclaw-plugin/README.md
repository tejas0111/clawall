# ClawAll OpenClaw Plugin

Real OpenClaw plugin backed by ClawAll gateway.

## 1) Start gateway

```bash
# from your local clawall repo root
npm run gateway
```

Default API URL: `http://127.0.0.1:3011`

## 2) Install plugin

```bash
openclaw plugins install ./src/plugins/clawall-openclaw-plugin
```

Restart OpenClaw gateway after install.

## Methods

- `clawall.status`
- `clawall.check`
- `clawall.signed_transfer`
- `clawall.wallet`
- `clawall.price`

## Commands

- `clawall_status`
- `clawall_check`
- `clawall_wallet`
- `clawall_price`
- `clawall_snapshot`
- `clawall_transfer`
- `clawall_transfer_quote`

Natural language routing examples:

- `send 0.0023 hasui to 0x...`
- `send 0.034 sui and 0.0034 wal to 0x...`
- `send 0.0034 hawal to 0x... and 0.34 usdc too and tell me my wallet bal`
- `send 0.0324 sui to 0x... and tell me exact price in usd`
- `show me price of sui and my wallet bal`

## CLI

- `openclaw clawall status`
- `openclaw clawall check`
- `openclaw clawall transfer --amount <mist> [--recipient <0x...>]`
- `openclaw clawall transfer-quote --amount <mist|sui> [--recipient <0x...>]`
- `openclaw clawall wallet`
- `openclaw clawall price --coin-type <0x...::module::struct> [--amount <base_units>]`

## Plugin config

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

## Hard lock for transfer routing

Gateway enforces auth on `/v1/signed-transfer` using `CLAWALL_PLUGIN_KEY`.

- If key missing/invalid: transfer is rejected with `401 unauthorized`.
- Plugin sends `x-clawall-plugin-key` automatically from `api_key`.

This blocks direct curl/app bypass for signed transfers.

## Required env for signed transfer route

- `PRIVATE_KEY`
- `GUARD_CAP_ID`
- `FREEZE_STATE_ID`
- `PACKAGE_ID`
- `RPC_URL`
- `CLAWALL_PLUGIN_KEY`
- `CLAWALL_ENFORCE_PLUGIN_GATE=1`
