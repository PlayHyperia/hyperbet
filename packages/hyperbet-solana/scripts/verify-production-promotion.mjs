#!/usr/bin/env node

import { evaluateSolProductionPromotion } from "./production-promotion.mjs";

function parseArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

const result = evaluateSolProductionPromotion({
  environment: parseArg("--environment"),
  confirmation: parseArg("--confirmation"),
  expectedCommitSha: parseArg("--expected-sha"),
  ref: parseArg("--ref"),
  actualCommitSha: parseArg("--actual-sha"),
});

for (const check of result.checks) {
  console.log(`${check.ok ? "[ok]" : "[fail]"} ${check.message}`);
}
console.log(JSON.stringify(result, null, 2));
if (!result.ok) process.exitCode = 1;
