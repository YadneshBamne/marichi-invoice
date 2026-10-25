// Prints a new VAPID key pair for browser push. Run once, put the lines in .env and keep the private key secret:
//   node scripts/vapid-keys.mjs
// Do not regenerate later: every browser would have to subscribe again.
import { createECDH } from "node:crypto";

const e = createECDH("prime256v1");
e.generateKeys();
console.log(`NEXT_PUBLIC_VAPID_PUBLIC_KEY=${e.getPublicKey().toString("base64url")}`);
console.log(`VAPID_PRIVATE_KEY=${e.getPrivateKey().toString("base64url")}`);
console.log("VAPID_SUBJECT=mailto:you@your-domain.example");
