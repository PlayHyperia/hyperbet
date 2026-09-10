import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

type SenderTransaction = Transaction | VersionedTransaction;

export function decodeSenderTransaction(
  transaction: string,
): SenderTransaction {
  const raw = Buffer.from(transaction, "base64");
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    return Transaction.from(raw);
  }
}

function extractSenderProgramIds(transaction: SenderTransaction): string[] {
  if (transaction instanceof VersionedTransaction) {
    const accountKeys = transaction.message.staticAccountKeys;
    return transaction.message.compiledInstructions.map(
      (instruction: { programIdIndex: number }) =>
        accountKeys[instruction.programIdIndex]?.toBase58() ?? "",
    );
  }
  return transaction.instructions.map((instruction: { programId: PublicKey }) =>
    instruction.programId.toBase58(),
  );
}

export function isWhitelistedSenderTransaction(
  transaction: SenderTransaction,
  hyperbetProgramIds: ReadonlySet<string>,
): boolean {
  if (hyperbetProgramIds.size === 0) return false;

  const allowedPrograms = new Set([
    ...hyperbetProgramIds,
    ComputeBudgetProgram.programId.toBase58(),
    SystemProgram.programId.toBase58(),
  ]);
  const programIds = extractSenderProgramIds(transaction);
  const touchesHyperbetProgram = programIds.some((programId) =>
    hyperbetProgramIds.has(programId),
  );

  return (
    programIds.length > 0 &&
    touchesHyperbetProgram &&
    programIds.every(
      (programId) => programId.length > 0 && allowedPrograms.has(programId),
    )
  );
}
