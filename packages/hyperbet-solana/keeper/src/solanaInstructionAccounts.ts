import { PublicKey } from "@solana/web3.js";

export function exactSolanaPublicKeyAddress(value: unknown): string | null {
  try {
    let address: unknown = value;
    if (typeof value === "object" && value !== null && "pubkey" in value) {
      address = (value as { pubkey?: unknown }).pubkey;
    }
    if (
      typeof address === "object" &&
      address !== null &&
      "toBase58" in address &&
      typeof (address as { toBase58?: unknown }).toBase58 === "function"
    ) {
      address = (address as { toBase58(): unknown }).toBase58();
    }
    if (typeof address !== "string" || !address) return null;
    return new PublicKey(address).toBase58() === address ? address : null;
  } catch {
    return null;
  }
}

export function exactInstructionAccountAddresses(
  accounts: unknown,
): string[] | null {
  if (!Array.isArray(accounts)) return null;
  const addresses: string[] = [];
  for (const account of accounts) {
    const address = exactSolanaPublicKeyAddress(account);
    if (!address) return null;
    addresses.push(address);
  }
  return addresses;
}

export function exactTransactionSignerAddresses(
  accountKeys: unknown,
  expectedSignerCount: unknown,
): string[] | null {
  try {
    if (
      !Array.isArray(accountKeys) ||
      !Number.isSafeInteger(expectedSignerCount) ||
      (expectedSignerCount as number) <= 0 ||
      (expectedSignerCount as number) > accountKeys.length
    ) {
      return null;
    }
    const signerAddresses: string[] = [];
    for (const [index, account] of accountKeys.entries()) {
      if (
        typeof account !== "object" ||
        account === null ||
        !("pubkey" in account)
      ) {
        return null;
      }
      const signer = (account as { signer?: unknown }).signer;
      if (
        typeof signer !== "boolean" ||
        signer !== index < (expectedSignerCount as number)
      ) {
        return null;
      }
      const address = exactSolanaPublicKeyAddress(
        (account as { pubkey?: unknown }).pubkey,
      );
      if (!address) return null;
      if (signer) signerAddresses.push(address);
    }
    return signerAddresses;
  } catch {
    return null;
  }
}
