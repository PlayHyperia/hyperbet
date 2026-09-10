import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PROVIDER_OUTPUT_BYTES = 1_048_576;
const MAX_DEPLOYMENT_ROWS = 100;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const PAGES_PROJECT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function requireExpectedValue(value, name) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 256 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
  return value;
}

function validateExpectedIdentity(input) {
  const expectedCommitSha = requireExpectedValue(
    input.expectedCommitSha,
    "EXPECTED_COMMIT_SHA",
  ).toLowerCase();
  if (!COMMIT_SHA.test(expectedCommitSha)) {
    throw new Error("EXPECTED_COMMIT_SHA is invalid");
  }

  const expectedEnvironment = requireExpectedValue(
    input.expectedEnvironment,
    "EXPECTED_PAGES_ENVIRONMENT",
  );
  const expectedBranch = requireExpectedValue(
    input.expectedBranch,
    "EXPECTED_PAGES_BRANCH",
  );
  if (
    (expectedEnvironment === "production" && expectedBranch !== "main") ||
    (expectedEnvironment === "preview" && expectedBranch !== "staging") ||
    (expectedEnvironment !== "production" && expectedEnvironment !== "preview")
  ) {
    throw new Error("Pages environment and branch are inconsistent");
  }

  const expectedProjectName = requireExpectedValue(
    input.expectedProjectName,
    "EXPECTED_PAGES_PROJECT_NAME",
  );
  if (!PAGES_PROJECT_NAME.test(expectedProjectName)) {
    throw new Error("EXPECTED_PAGES_PROJECT_NAME is invalid");
  }

  return {
    expectedCommitSha,
    expectedEnvironment,
    expectedBranch,
    expectedProjectName,
  };
}

function parseProviderRows(rawJson) {
  if (
    typeof rawJson !== "string" ||
    !rawJson ||
    Buffer.byteLength(rawJson, "utf8") > MAX_PROVIDER_OUTPUT_BYTES
  ) {
    throw new Error("Pages deployment-list JSON is invalid");
  }
  let parsed;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error("Pages deployment-list JSON is invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length < 1 ||
    parsed.length > MAX_DEPLOYMENT_ROWS
  ) {
    throw new Error("Pages deployment-list rows are invalid");
  }
  return parsed;
}

function validateDeploymentUrl(value, expectedProjectName) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2_048 ||
    value !== value.trim() ||
    CONTROL_CHARACTER.test(value)
  ) {
    throw new Error("Pages deployment URL is invalid");
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Pages deployment URL is invalid");
  }
  const hostname = parsed.hostname.toLowerCase();
  const projectHostname = `${expectedProjectName}.pages.dev`;
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    (hostname !== projectHostname && !hostname.endsWith(`.${projectHostname}`))
  ) {
    throw new Error("Pages deployment URL is invalid");
  }
  return parsed.origin;
}

export function resolvePagesDeploymentOutput(input) {
  const identity = validateExpectedIdentity(input);
  const rows = parseProviderRows(input.rawJson);
  const expectedSource = identity.expectedCommitSha.slice(0, 7);
  const matchingRows = rows.filter(
    (row) =>
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      row.Source === expectedSource &&
      row.Environment === identity.expectedEnvironment &&
      row.Branch === identity.expectedBranch,
  );
  if (matchingRows.length < 1) {
    throw new Error("Exact Pages deployment was not found");
  }

  const deployedUrls = matchingRows.map((row) =>
    validateDeploymentUrl(row.Deployment, identity.expectedProjectName),
  );
  return Object.freeze({ deployed_url: deployedUrls[0] });
}

export function serializePagesDeploymentOutput(output) {
  if (
    !output ||
    typeof output !== "object" ||
    Array.isArray(output) ||
    Object.keys(output).length !== 1 ||
    typeof output.deployed_url !== "string" ||
    !output.deployed_url ||
    output.deployed_url !== output.deployed_url.trim() ||
    CONTROL_CHARACTER.test(output.deployed_url)
  ) {
    throw new Error("Pages deployment output has unexpected keys or values");
  }
  return `deployed_url=${output.deployed_url}\n`;
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  try {
    const rawJson = readFileSync(0, "utf8");
    process.stdout.write(
      serializePagesDeploymentOutput(
        resolvePagesDeploymentOutput({
          rawJson,
          expectedCommitSha: process.env.EXPECTED_COMMIT_SHA,
          expectedEnvironment: process.env.EXPECTED_PAGES_ENVIRONMENT,
          expectedBranch: process.env.EXPECTED_PAGES_BRANCH,
          expectedProjectName: process.env.EXPECTED_PAGES_PROJECT_NAME,
        }),
      ),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid input";
    process.stderr.write(
      `Pages deployment output resolution failed: ${message}\n`,
    );
    process.exitCode = 1;
  }
}
