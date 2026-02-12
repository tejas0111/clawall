import 'dotenv/config';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';

export function getDemoExecutionContext() {
  const suiPrivKey = process.env.PRIVATE_KEY;
  const guardCapId = process.env.GUARD_CAP_ID;

  if (!suiPrivKey || !guardCapId) {
    throw new Error('Missing PRIVATE_KEY or GUARD_CAP_ID in .env');
  }

  // ✅ Correct for suiprivkey1... format
  const { secretKey } = decodeSuiPrivateKey(suiPrivKey);

  const signer = Ed25519Keypair.fromSecretKey(secretKey);

  return {
    signer,
    guardCapId,
  };
}

export function buildDemoConstraint(recipient) {
  return {
    max_amount: 300_000_000,        // 0.3 SUI
    allowed_recipient: recipient,
    expiry_ms: Date.now() + 5 * 60 * 1000,
    nonce: [],
  };
}

