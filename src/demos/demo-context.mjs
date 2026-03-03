import 'dotenv/config';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

const OBJECT_ID_RE = /^0x[a-fA-F0-9]+$/;

export function getDemoExecutionContext() {
  const suiPrivKey = process.env.PRIVATE_KEY;
  const guardCapId = process.env.GUARD_CAP_ID;
  const freezeStateId = process.env.FREEZE_STATE_ID;
  const vaultId = process.env.VAULT_ID;

  if (!suiPrivKey || !guardCapId || !freezeStateId || !vaultId) {
    throw new Error('Missing PRIVATE_KEY, GUARD_CAP_ID, VAULT_ID, or FREEZE_STATE_ID in .env');
  }

  const { secretKey } = decodeSuiPrivateKey(suiPrivKey);
  
  if (!OBJECT_ID_RE.test(guardCapId)) {
    throw new Error('GUARD_CAP_ID must be a 0x-prefixed object id');
  }
  if (!OBJECT_ID_RE.test(freezeStateId)) {
    throw new Error('FREEZE_STATE_ID must be a 0x-prefixed object id');
  }
  if (!OBJECT_ID_RE.test(vaultId)) {
    throw new Error('VAULT_ID must be a 0x-prefixed object id');
  }

  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  return {
    signer,
    guardCapId,
    freezeStateId,
    vaultId,
  };
}
