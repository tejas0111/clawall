import 'dotenv/config';
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { computePolicyBundleHash } from './policy-integrity.mjs';
import { upsertPolicyAnchor, verifyPolicyAnchorIntegrity } from './policy-anchor.mjs';

function requiredEnv(name) {
  const value = String(process.env[name] ?? '').trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

async function main() {
  const privateKey = process.env.ADMIN_PRIVATE_KEY || requiredEnv('PRIVATE_KEY');
  const policyCapId = requiredEnv('POLICY_CAP_ID');
  const packageId = requiredEnv('PACKAGE_ID');
  const anchorId = String(process.env.POLICY_ANCHOR_ID ?? '').trim();

  const { secretKey } = decodeSuiPrivateKey(privateKey);
  const signer = Ed25519Keypair.fromSecretKey(secretKey);
  const { sha256 } = computePolicyBundleHash();

  const tx = await upsertPolicyAnchor({
    signer,
    policyCapId,
    packageId,
    anchorId: anchorId || null,
    policyHash: sha256,
  });

  const verification = await verifyPolicyAnchorIntegrity({
    expectedSha256: sha256,
    anchorId: tx.anchor_id,
    packageId,
    force: true,
  });

  if (!verification.ok) {
    throw new Error(`Anchor verification failed: ${verification.reason}`);
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        policy_sha256: sha256,
        anchor_id: tx.anchor_id,
        action: tx.action,
        digest: tx.digest,
        set_env: `POLICY_ANCHOR_ID=${tx.anchor_id}`,
      },
      null,
      2
    )
  );
}

main().catch((err) => {
  console.error(err?.message ?? String(err));
  process.exit(1);
});
