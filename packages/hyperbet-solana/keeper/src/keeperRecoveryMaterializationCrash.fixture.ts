import { writeFileSync } from "node:fs";

import { materializeKeeperRecoverySet } from "./keeperRecoveryMaterialization";

const [
  keeperBackupPath,
  keeperEvidencePath,
  operatorAlertBackupPath,
  operatorAlertEvidencePath,
  manifestPath,
  destinationContainerPath,
  readyPath,
  expectedReleaseSha,
  expectedOperatorAlertRouteId,
  expectedBoundaryId,
  materializationId,
] = process.argv.slice(2);

if (
  !keeperBackupPath ||
  !keeperEvidencePath ||
  !operatorAlertBackupPath ||
  !operatorAlertEvidencePath ||
  !manifestPath ||
  !destinationContainerPath ||
  !readyPath ||
  !expectedReleaseSha ||
  !expectedOperatorAlertRouteId ||
  !expectedBoundaryId ||
  !materializationId
) {
  throw new Error("missing recovery materialization crash-fixture argument");
}

await materializeKeeperRecoverySet({
  keeperBackupPath,
  keeperEvidencePath,
  operatorAlertBackupPath,
  operatorAlertEvidencePath,
  manifestPath,
  expectedReleaseSha,
  expectedCluster: "devnet",
  expectedOperatorAlertRouteId,
  expectedBoundaryId,
  destinationContainerPath,
  createId: () => materializationId,
  beforePublish: async () => {
    writeFileSync(readyPath, "verified-before-publication\n", {
      flag: "wx",
      mode: 0o600,
    });
    await new Promise<void>(() => {
      setInterval(() => {}, 1_000);
    });
  },
});
