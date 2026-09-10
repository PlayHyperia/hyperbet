import fs from "node:fs";
import path from "node:path";

import {
  parseGeneratedCorpus,
  parseGeneratedFailureArtifact,
  promoteGeneratedFailure,
} from "../tests/generated-state-machine-replay";

function requiredArgument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv
    .slice(2)
    .find((argument) => argument.startsWith(prefix));
  if (!value || value.slice(prefix.length).trim() === "") {
    throw new Error(`missing required ${prefix}<value> argument`);
  }
  return value.slice(prefix.length);
}

const artifactPath = path.resolve(requiredArgument("artifact"));
const corpusPath = path.resolve(
  process.argv
    .slice(2)
    .find((argument) => argument.startsWith("--corpus="))
    ?.slice("--corpus=".length) ??
    path.join(
      import.meta.dirname,
      "../tests/fixtures/duel-market-generated-corpus.json",
    ),
);
const replayId = requiredArgument("id");

const artifact = parseGeneratedFailureArtifact(
  JSON.parse(fs.readFileSync(artifactPath, "utf8")) as unknown,
);
const corpus = parseGeneratedCorpus(
  JSON.parse(fs.readFileSync(corpusPath, "utf8")) as unknown,
);
const promoted = promoteGeneratedFailure(corpus, artifact, replayId);
const temporaryPath = `${corpusPath}.tmp-${process.pid}`;
fs.writeFileSync(temporaryPath, `${JSON.stringify(promoted, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
});
fs.renameSync(temporaryPath, corpusPath);
process.stdout.write(
  `${JSON.stringify({ ok: true, replayId, corpusPath, randomWords: artifact.reducedRandomWords.length })}\n`,
);
