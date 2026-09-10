import type { WalletSession, SolanaClient } from "@solana/client";
import { createWalletTransactionSigner, toAddress } from "@solana/client";
import { AccountRole, type AccountMeta, type Instruction } from "@solana/kit";
import { getSetComputeUnitLimitInstruction } from "@solana-program/compute-budget";
import { getSetComputeUnitPriceInstruction } from "@solana-program/compute-budget";
import { getTransferSolInstruction } from "@solana-program/system";

import {
  fetchPriorityFeeEstimate,
  HELIUS_SENDER_MIN_TIP_LAMPORTS,
  randomJitoTipAccount,
  sendViaHeliusSender,
} from "@hyperbet/ui/lib/solanaRpc";

type RemainingAccountLike = {
  isSigner: boolean;
  isWritable: boolean;
  pubkey: { toBase58(): string };
};

function toAccountRole(account: RemainingAccountLike) {
  if (account.isSigner) {
    return account.isWritable
      ? AccountRole.WRITABLE_SIGNER
      : AccountRole.READONLY_SIGNER;
  }
  return account.isWritable ? AccountRole.WRITABLE : AccountRole.READONLY;
}

export function toKitRemainingAccounts(
  remainingAccounts: readonly RemainingAccountLike[],
): AccountMeta[] {
  return remainingAccounts.map((account) => ({
    address: toAddress(account.pubkey.toBase58()),
    role: toAccountRole(account),
  }));
}

export function appendRemainingAccounts<TInstruction extends Instruction>(
  instruction: TInstruction,
  remainingAccounts: readonly AccountMeta[],
): TInstruction {
  if (remainingAccounts.length === 0) {
    return instruction;
  }
  return {
    ...instruction,
    accounts: [...(instruction.accounts ?? []), ...remainingAccounts],
  } as TInstruction;
}

export async function sendKitInstructions(
  client: SolanaClient,
  walletSession: WalletSession,
  instructions: readonly Instruction[],
  options: {
    accountKeys?: readonly string[];
    computeUnitLimit?: number;
    context: string;
    gameApiUrl?: string;
    useHeliusSender?: boolean;
  },
): Promise<string> {
  const {
    accountKeys = [],
    computeUnitLimit = 200_000,
    context,
    useHeliusSender = false,
  } = options;
  const rpcEndpoint = client.store.getState().cluster.endpoint;
  const transactionSigner = createWalletTransactionSigner(walletSession).signer;

  let stage = "preparing transaction";
  try {
    let preparedInstructions = [...instructions];
    let computeUnitLimitBigInt: bigint | undefined;

    if (useHeliusSender) {
      const priorityFee = await fetchPriorityFeeEstimate(rpcEndpoint, [
        ...accountKeys,
      ]);
      computeUnitLimitBigInt = BigInt(computeUnitLimit);
      preparedInstructions = [
        getSetComputeUnitLimitInstruction({ units: computeUnitLimit }),
        getSetComputeUnitPriceInstruction({
          microLamports: BigInt(priorityFee),
        }),
        getTransferSolInstruction({
          amount: BigInt(HELIUS_SENDER_MIN_TIP_LAMPORTS),
          destination: toAddress(randomJitoTipAccount()),
          source: transactionSigner,
        }),
        ...preparedInstructions,
      ];
    }

    const prepared = await client.transaction.prepare({
      authority: transactionSigner,
      computeUnitLimit: computeUnitLimitBigInt,
      instructions: preparedInstructions,
      version: "auto",
    });

    stage = "sending transaction";
    let signature: string;
    if (useHeliusSender) {
      const wire = await client.transaction.toWire(prepared);
      const base64 = Buffer.from(wire).toString("base64");
      signature = await sendViaHeliusSender(base64);
    } else {
      signature = (await client.transaction.send(prepared)).toString();
    }

    stage = "confirming transaction";
    // Confirmation is handled by the caller via connection.confirmTransaction or polling
    return signature;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${context}: ${stage}: ${message}`, { cause: error });
  }
}
