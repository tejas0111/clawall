import { writePolicySignatureFile } from './policy-integrity.mjs';

const payload = writePolicySignatureFile();
console.log(`policy bundle signature updated: ${payload.sha256}`);
