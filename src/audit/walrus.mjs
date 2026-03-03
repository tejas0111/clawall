import 'dotenv/config';
import fs from 'fs';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { WalrusClient, WalrusFile } from '@mysten/walrus';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

let WALRUS = null;
let OS_AUDIT_SIGNER = null;
const osEventQueue = [];
const OS_QUILT_MAX_QUEUE = 1_000;
const OS_QUILT_BATCH_SIZE = 25;
const OS_QUILT_EPOCHS = 15;
const AUDIT_EPOCHS = 15;
const RPC_URL = process.env.RPC_URL || 'https://fullnode.testnet.sui.io:443';
const NETWORK = process.env.NETWORK || 'testnet';
const MAX_RETRIES = Number(process.env.WALRUS_MAX_RETRIES ?? '3');
const RETRY_DELAY_MS = 1_000;
const AUDIT_MODE = process.env.WALRUS_AUDIT_MODE || 'blob';
const UPLOAD_RELAY_HOST = process.env.WALRUS_UPLOAD_RELAY || '';
const UPLOAD_RELAY_TIP_MAX = Number(process.env.WALRUS_UPLOAD_RELAY_TIP_MAX ?? '');
const WALRUS_REQ_TIMEOUT_MS = Number(process.env.WALRUS_REQ_TIMEOUT_MS ?? '');

export function initWalrus() {
  if (WALRUS) return WALRUS;
  const suiClient = new SuiJsonRpcClient({ url: RPC_URL });
  const uploadRelay = UPLOAD_RELAY_HOST
    ? {
        host: UPLOAD_RELAY_HOST,
        ...(Number.isFinite(WALRUS_REQ_TIMEOUT_MS) && WALRUS_REQ_TIMEOUT_MS > 0
          ? { timeout: WALRUS_REQ_TIMEOUT_MS }
          : {}),
        ...(Number.isFinite(UPLOAD_RELAY_TIP_MAX) && UPLOAD_RELAY_TIP_MAX > 0
          ? { sendTip: { max: Math.floor(UPLOAD_RELAY_TIP_MAX) } }
          : {}),
      }
    : undefined;

  WALRUS = new WalrusClient({
    network: NETWORK,
    suiClient,
    ...(uploadRelay ? { uploadRelay } : {}),
  });
  OS_AUDIT_SIGNER = initOSAuditSigner();
  console.log(
    `Walrus initialized (${NETWORK}, mode=${AUDIT_MODE}${uploadRelay ? `, relay=${UPLOAD_RELAY_HOST}` : ''})`
  );
  return WALRUS;
}

function initOSAuditSigner() {
  const key = process.env.OS_AUDIT_PRIVATE_KEY || process.env.PRIVATE_KEY;
  if (!key) return null;
  try {
    const { secretKey } = decodeSuiPrivateKey(key);
    return Ed25519Keypair.fromSecretKey(secretKey);
  } catch { return null; }
}

function createWalrusSigner(keypair) {
  if (!keypair) return null;
  const suiClient = new SuiJsonRpcClient({ url: RPC_URL });
  return {
    toSuiAddress: () => keypair.toSuiAddress(),
    signAndExecuteTransaction: async ({ transaction }) => {
      const address = keypair.toSuiAddress();
      try {
        const coins = await suiClient.getCoins({ owner: address });
        const sorted = coins.data.sort((a, b) => Number(b.balance) - Number(a.balance));
        if (sorted.length > 0) {
          transaction.setGasPayment([
            {
              objectId: sorted[0].coinObjectId, // Correctly use objectId key
              version: sorted[0].version,
              digest: sorted[0].digest,
            }
          ]);
        }

        const { bytes, signature } = await transaction.sign({ client: suiClient, signer: keypair });
        const res = await suiClient.executeTransactionBlock({
          transactionBlock: bytes,
          signature,
          options: { showEffects: true, showObjectChanges: true },
        });

        const changedObjects = Array.isArray(res.objectChanges)
          ? res.objectChanges
              .filter((change) => change?.type === 'created' && change?.objectId)
              .map((change) => ({
                objectId: change.objectId,
                idOperation: 'Created',
              }))
          : undefined;

        const effects = res.effects ?? (changedObjects ? { changedObjects } : undefined);
        if (effects && changedObjects && !effects.changedObjects) {
          effects.changedObjects = changedObjects;
        }
        
        return {
          ...res,
          digest: res.digest,
          Transaction: {
            digest: res.digest,
            effects,
          }
        };
      } catch (err) {
        console.error('[walrus-signer] tx execution failed:', err.message);
        throw err;
      }
    }
  };
}

export async function logProposal({ proposal, risk, constraint, signer: keypair }) {
  if (!WALRUS) initWalrus();
  const signer = createWalrusSigner(keypair);

  if (!proposal?.id) {
    console.warn('Walrus audit skipped: missing proposal id');
    return null;
  }
  if (!risk || risk.risk_level === undefined || risk.risk_level === null) {
    console.warn('Walrus audit skipped: missing risk level');
    return null;
  }
  
  const payload = {
    proposal_id: proposal.id,
    action: proposal.action,
    amount: proposal.params?.amount,
    recipient: proposal.params?.recipient,
    risk_level: risk.risk_level,
    constraint,
    timestamp: new Date().toISOString()
  };

  const payloadJson = JSON.stringify(payload);
  const blobBytes = new TextEncoder().encode(payloadJson);

  for (let i = 1; i <= MAX_RETRIES; i++) {
    try {
      const { blobId } = await WALRUS.writeBlob({
        blob: blobBytes,
        signer,
        deletable: false,
        epochs: AUDIT_EPOCHS,
      });
      return blobId;
    } catch (err) {
      if (i === MAX_RETRIES) {
        console.warn('Walrus audit failed:', err?.message ?? err, {
          payload_bytes: blobBytes?.length ?? null,
          has_signer: !!signer,
          mode: AUDIT_MODE,
          upload_relay: UPLOAD_RELAY_HOST || null,
          stack: err?.stack ?? null,
          cause: err?.cause ?? null,
          cause_stack: err?.cause?.stack ?? null,
        });
        return null;
      }
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS * i));
    }
  }
  return null;
}

export function enqueueOSSecurityEvent(event) { /* Simple stub for cleanup */ }
