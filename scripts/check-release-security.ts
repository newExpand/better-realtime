import { checkReleaseSecurity } from "./release-security-contract.ts";

const result = await checkReleaseSecurity();
process.stdout.write(`${JSON.stringify({ schemaVersion: "1.0", authority: "packages-all-read-write", checked: result.checked })}\n`);
