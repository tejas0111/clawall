import 'dotenv/config';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { WalrusClient } from '@mysten/walrus';

let WALRUS = null;

const RPC_URL =
  process.env.RPC_URL || 'https://fullnode.testnet.sui.io:443';

const NETWORK =
  process.env.NETWORK || 'testnet';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1_000;

export function initWalrus() {
  if (WALRUS) return WALRUS;

  const suiClient = new SuiJsonRpcClient({ url: RPC_URL });

  WALRUS = new WalrusClient({
    network: NETWORK,
    suiClient,
  });

  console.log(`Walrus initialized (${NETWORK})`);
  return WALRUS;
}

function encodeBlob(data) {
  return new TextEncoder().encode(JSON.stringify(data));
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

export async function logProposal({
  proposal,
  risk,
  constraint = null,
  decision = 'PENDING',
  signer,
  approvedBy,
}) {
  if (!WALRUS) {
    throw new Error('Walrus not initialized');
  }

  if (!signer) {
    throw new Error('Signer required for Walrus upload');
  }

  if (!proposal || !risk) {
    throw new Error('proposal and risk are required');
  }

  const payload = {
    schema: 'constraint-layer/v1',
    proposal_id: proposal.id,
    created_at: new Date().toISOString(),

    action: proposal.action,
    amount: proposal.params?.amount,
    recipient: proposal.params?.recipient,

    risk: {
      level: risk.risk_level,
      score: risk.risk_score ?? null,
      reasoning: risk.reasoning,
    },

    constraint,
    decision,
    approved_by: approvedBy || signer.toSuiAddress(),
  };

  const blobBytes = encodeBlob(payload);

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { blobId } = await WALRUS.writeBlob({
        blob: blobBytes,
        signer,
        deletable: false,
        epochs: 15,
      });

      if (!blobId) {
        throw new Error('No blobId returned');
      }

      return blobId;
    } catch (err) {
      if (attempt === MAX_RETRIES) {
        console.warn(
          'Walrus upload failed after retries:',
          err.message
        );
        return null;
      }

      await delay(RETRY_DELAY_MS * attempt);
    }
  }

  return null;
}

