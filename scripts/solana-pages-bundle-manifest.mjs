import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

const MAX_ARTIFACTS = 10_000;
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function resolveSolanaPagesBundleManifest(rootPath) {
  if (
    typeof rootPath !== "string" ||
    !rootPath ||
    !isAbsolute(rootPath) ||
    CONTROL_CHARACTER.test(rootPath)
  ) {
    throw new Error("Pages bundle root is invalid");
  }
  const root = resolve(rootPath);
  let rootStat;
  try {
    rootStat = lstatSync(root);
  } catch {
    throw new Error("Pages bundle root does not exist");
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error("Pages bundle root must be a real directory");
  }

  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw new Error("Pages bundle must not contain a symbolic link");
      }
      if (stat.isDirectory()) {
        visit(path);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error("Pages bundle contains an unsupported entry");
      }
      const fileName = relative(root, path).split(sep).join("/");
      if (fileName === "build-info.json") continue;
      if (
        !fileName ||
        fileName.length > 512 ||
        CONTROL_CHARACTER.test(fileName) ||
        stat.size < 0 ||
        stat.size > MAX_ARTIFACT_BYTES
      ) {
        throw new Error("Pages bundle artifact is invalid");
      }
      files.push({ fileName, path, expectedBytes: stat.size });
      if (files.length > MAX_ARTIFACTS) {
        throw new Error("Pages bundle contains too many artifacts");
      }
    }
  };
  visit(root);
  if (files.length < 1) {
    throw new Error("Pages bundle manifest cannot be empty");
  }

  let totalBytes = 0;
  const artifacts = files
    .sort((left, right) => left.fileName.localeCompare(right.fileName))
    .map((file) => {
      const contents = readFileSync(file.path);
      if (contents.byteLength !== file.expectedBytes) {
        throw new Error("Pages bundle artifact changed during inspection");
      }
      totalBytes += contents.byteLength;
      if (totalBytes > MAX_BUNDLE_BYTES) {
        throw new Error("Pages bundle exceeds its bounded size");
      }
      return {
        fileName: file.fileName,
        bytes: contents.byteLength,
        sha256: sha256(contents),
      };
    });

  return Object.freeze({
    schemaVersion: 1,
    artifactCount: artifacts.length,
    manifestSha256: sha256(JSON.stringify(artifacts)),
  });
}
