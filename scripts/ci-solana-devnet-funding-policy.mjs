const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_VALUES = new Map(
  Array.from(BASE58_ALPHABET, (character, index) => [character, BigInt(index)]),
);
const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_RECIPIENTS = 12;
const MAX_LAMPORTS_PER_RECIPIENT = 10n * LAMPORTS_PER_SOL;

function decodedBase58Length(value) {
  let numericValue = 0n;
  for (const character of value) {
    const digit = BASE58_VALUES.get(character);
    if (digit === undefined) return null;
    numericValue = numericValue * 58n + digit;
  }

  let numericBytes = 0;
  for (let remaining = numericValue; remaining > 0n; remaining >>= 8n) {
    numericBytes += 1;
  }
  let leadingZeroBytes = 0;
  while (value[leadingZeroBytes] === "1") leadingZeroBytes += 1;
  return leadingZeroBytes + numericBytes;
}

function parseAmountLamports(value) {
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,9}))?$/.exec(value);
  if (!match) {
    throw new Error(
      "Each funding amount must be canonical decimal SOL with at most nine fractional digits",
    );
  }
  const whole = BigInt(match[1]);
  const fractionalDigits = match[2] ?? "";
  const fractional = BigInt(fractionalDigits.padEnd(9, "0") || "0");
  const lamports = whole * LAMPORTS_PER_SOL + fractional;
  if (lamports <= 0n || lamports > MAX_LAMPORTS_PER_RECIPIENT) {
    throw new Error(
      "Each funding amount must be greater than zero and at most 10 SOL",
    );
  }
  const canonicalFraction = fractionalDigits.replace(/0+$/u, "");
  return {
    amountLamports: lamports,
    amountSol:
      canonicalFraction.length > 0
        ? `${whole}.${canonicalFraction}`
        : whole.toString(),
  };
}

export function parseSolanaDevnetFundingPlan(rawRecipients) {
  if (typeof rawRecipients !== "string") {
    throw new Error("Funding recipients must be one comma-separated string");
  }
  const entries = rawRecipients.split(",");
  if (entries.length < 1 || entries.length > MAX_RECIPIENTS) {
    throw new Error("Provide between 1 and 12 unique recipients");
  }

  const seenAddresses = new Set();
  const recipients = entries.map((rawEntry, index) => {
    const entry = rawEntry.trim();
    const separator = entry.indexOf("=");
    if (
      separator <= 0 ||
      separator !== entry.lastIndexOf("=") ||
      separator === entry.length - 1
    ) {
      throw new Error(
        `Recipient ${index + 1} must use Base58Address=SOLAmount`,
      );
    }
    const address = entry.slice(0, separator).trim();
    const amount = entry.slice(separator + 1).trim();
    if (/\s/u.test(address) || /\s/u.test(amount)) {
      throw new Error(`Recipient ${index + 1} contains embedded whitespace`);
    }
    if (decodedBase58Length(address) !== 32) {
      throw new Error(`Recipient ${index + 1} is not a 32-byte Solana address`);
    }
    if (seenAddresses.has(address)) {
      throw new Error(`Recipient ${index + 1} duplicates an earlier address`);
    }
    seenAddresses.add(address);

    const parsedAmount = parseAmountLamports(amount);
    return {
      address,
      amountSol: parsedAmount.amountSol,
      amountLamports: parsedAmount.amountLamports.toString(),
    };
  });

  const totalLamports = recipients.reduce(
    (total, recipient) => total + BigInt(recipient.amountLamports),
    0n,
  );
  return {
    schemaVersion: 1,
    cluster: "devnet",
    asset: "SOL",
    atomicUnit: "lamports",
    recipients,
    totalLamports: totalLamports.toString(),
  };
}

function parseCli(argv) {
  let recipients;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--recipients") {
      recipients = argv[index + 1];
      index += 1;
      continue;
    }
    if (argument.startsWith("--recipients=")) {
      recipients = argument.slice("--recipients=".length);
      continue;
    }
    throw new Error(`Unknown funding-policy option: ${argument}`);
  }
  if (recipients === undefined) {
    throw new Error("Missing required --recipients value");
  }
  return recipients;
}

const invokedPath = process.argv[1];
if (invokedPath && new URL(import.meta.url).pathname === invokedPath) {
  try {
    const plan = parseSolanaDevnetFundingPlan(parseCli(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(plan)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`Solana devnet funding plan rejected: ${message}\n`);
    process.exitCode = 1;
  }
}
