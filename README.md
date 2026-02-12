# 🦞 ClawAll
### Autonomous AI Constraint & Governance Layer for Sui

> AI agents should not have raw execution power.
> ClawAll gives them guardrails, enforcement, and human override.

https://raw.githubusercontent.com/tejas0111/clawall/src/demos/clawall.png
---

## 🎥 Demo Video

> **Watch ClawAll intercept a high-risk transfer, trigger Telegram approval, and engage the kill-switch in real time.**

https://raw.githubusercontent.com/tejas0111/clawall/src/demos/demo.mp4


---

## 🚨 Problem

AI agents executing real blockchain transactions are dangerous. Without constraints they can:

- Drain wallets via rapid micro-transactions
- Execute destructive OS commands
- Bypass human intent
- Escalate privileges cross-domain
- Execute high-value transfers without oversight

We need a **constraint layer between AI and execution**.

---

## 🧠 Solution: ClawAll

ClawAll is a **multi-layer AI enforcement system** that:

- Inspects intent before execution
- Scores transaction risk
- Applies policy decisions
- Requires Telegram approval for high-risk actions
- Engages persistent kill-switch on OS violations
- Enforces constraints on-chain using Move smart contracts
- Emits auditable events to Walrus + Sui

---

## 🏗 Architecture

```
AI Agent
   ↓
Intent Firewall
   ↓
Risk Engine
   ↓
Policy Engine
   ↓
Governance (Telegram)
   ↓
On-chain Move Enforcement
   ↓
Event + Walrus Audit
```

---

## 🔐 Core Security Layers

### 1️⃣ Intent Firewall

Blocks unsafe domains like:

- `rm -rf`
- Destructive OS commands
- Unauthorized domain escalation

---

### 2️⃣ Risk Engine

Multi-factor scoring system:

- Relative transfer size
- Absolute high value
- Recipient novelty
- Transaction velocity
- Cumulative spend
- Small chunk draining
- Behavior anomaly
- Risk compounding

Outputs:

```js
{
  risk_score: 82,
  risk_level: "HIGH",
  reasoning: "...",
}
```

---

### 3️⃣ Policy Engine

| Risk Level | Action                 |
| ---------- | ---------------------- |
| LOW        | Allow                  |
| MEDIUM     | Allow + Alert          |
| HIGH       | Require Human Approval |

---

### 4️⃣ Telegram Governance

- `/logs`
- `/tx <id>`
- `/freeze`
- `/resume`
- `/status`
- Inline Approve / Reject buttons

High-risk transfers generate:

```
⚠️ APPROVAL REQUIRED
[Approve ✅] [Reject ❌]
```

---

### 5️⃣ Kill Switch (Persistent)

Triggered by:

- Critical OS violations
- Manual Telegram `/freeze`

Stored in file:

```
kill-switch.json
```

Even if agent restarts → remains frozen.

---

### 6️⃣ On-Chain Enforcement (Move)

Transfer constraints are minted:

```move
public struct TransferConstraint {
    max_amount: u64,
    allowed_recipient: address,
    expiry_ms: u64,
}
```

Execution enforces:

- Max amount
- Allowed recipient
- Expiry time
- Canonical Sui clock
- Constraint deletion after execution

Emits event:

```move
TransferExecuted
```

Which is parsed by Telegram `/logs`.

---

## 🔗 On-Chain Audit

Every transfer emits:

- `constraint_id`
- `amount`
- `recipient`
- `timestamp`
- `Walrus audit blob`

You can view any transaction via:

```
https://suiscan.xyz/testnet/tx/<TX_DIGEST>
```

---

## 🖥 Interactive Demo Shell

clone repo:

```bash
git clone https://github.com/tejas0111/clawall
```

install dependencies:

```bash
npm install
```
Run:

```bash
npm run demo
```

Opens:

```
clawall>
```

Options:

```
1 → Normal transaction
2 → Medium risk
3 → High risk (approval)
4 → OS attack simulation
5 → Show freeze state
6 → Reset memory
0 → Exit
```

This allows live threat simulation during demo.

---

## 🧪 Example Demo Flows

### 🔴 Cross-Domain Containment

```
4 → OS attack
1 → Blockchain tx blocked
/resume in Telegram
1 → Works again
```

---

### 🟡 Human Governance

```
3 → High risk
Approve in Telegram
→ Transaction executes
```

or

```
3 → High risk
Reject in Telegram
→ Transaction blocked
```

---

### 🔒 Manual Emergency Freeze

Telegram:

```
/freeze
```

Shell:

```
1 → blocked
```

Resume:

```
/resume
```

---

## ⚙️ Environment Variables

Create `.env`:

```env
PRIVATE_KEY=<your_private_key>
GUARD_CAP_ID=<your_guard_cap_id>
RPC_URL=<sui_rpc_url>
PACKAGE_ID=<deployed_package_id>
TG_BOT_TOKEN=<telegram_bot_token>
TG_CHAT_ID=<telegram_chat_id>
```

---

## 🧩 Tech Stack

- **Sui Move** — Smart contract enforcement layer
- **Sui JSON-RPC** — On-chain transaction execution
- **Node.js (ESM)** — Agent runtime
- **Telegram Bot API** — Human governance interface
- **Walrus** — Decentralized audit blob storage
- **Custom Risk Engine** — Multi-factor behavioral scoring

---

## 🛡 Why This Matters

ClawAll proves that:

> AI agents can operate autonomously
> without sacrificing safety, auditability, and human control.

This is not just wallet protection. This is:

- **AI governance** — policy-driven execution decisions
- **Constraint-based execution** — on-chain enforced limits
- **Cross-domain enforcement** — OS violations freeze blockchain actions
- **Persistent safety layer** — survives agent restarts

---

## 🏆 Clawall Value

What makes this project strong:

- ✅ Real on-chain enforcement
- ✅ Real transactions on Sui testnet
- ✅ Persistent kill-switch (survives restarts)
- ✅ Human-in-the-loop governance via Telegram
- ✅ Cross-domain containment (OS → Blockchain freeze)
- ✅ Multi-factor risk scoring engine
- ✅ Full auditable execution trail (Walrus + Sui events)

---

## 📌 Future Roadmap

- Multi-sig governance
- DAO-based approval
- Behavior ML anomaly detection
- Production wallet plugin
- zk-risk proofs
- Agent identity attestation


