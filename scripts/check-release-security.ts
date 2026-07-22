import { checkReleaseSecurity } from "./release-security-contract.ts";

const result = await checkReleaseSecurity();
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: "1.2",
    documentedReleaseState: result.contractState,
    historicalBootstrapAuthority: "packages-all-read-write",
    checked: result.checked,
  })}\n`,
);
