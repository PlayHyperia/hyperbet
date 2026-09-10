import { PublicKey, SystemProgram } from "@solana/web3.js";

import { safeAccountInteger } from "./accountInteger";
import { exactBytes32 } from "./exactBytes32";

const DUEL_WINNER_MARKET_KIND = 1;
const DUEL_SEED = Buffer.from("duel");
const MARKET_SEED = Buffer.from("market");
const CONFIG_SEED = Buffer.from("config");
const VAULT_SEED = Buffer.from("vault");

type PublicKeyLike =
  PublicKey | string | { toBase58(): string } | null | undefined;

export type CanonicalLifecycleMarketIdentity = {
  marketRef: string;
  duelStateRef: string;
  duelKeyHex: string;
  marketKind: typeof DUEL_WINNER_MARKET_KIND;
};

export type CanonicalMarketCreationIdentity =
  CanonicalLifecycleMarketIdentity & {
    operatorRef: string;
    configRef: string;
    vaultRef: string;
  };

function publicKey(value: PublicKeyLike): PublicKey | null {
  try {
    if (value instanceof PublicKey) return value;
    if (typeof value === "string") return new PublicKey(value);
    if (value && typeof value.toBase58 === "function") {
      return new PublicKey(value.toBase58());
    }
  } catch {
    return null;
  }
  return null;
}

export function requireCanonicalLifecycleMarketIdentity(input: {
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  marketRef: PublicKeyLike;
  duelState: PublicKeyLike;
  duelKey: unknown;
  marketKind: unknown;
}): CanonicalLifecycleMarketIdentity {
  const marketRef = publicKey(input.marketRef);
  const storedDuelState = publicKey(input.duelState);
  const duelKey = exactBytes32(input.duelKey);
  const marketKind = safeAccountInteger(input.marketKind);
  if (
    !marketRef ||
    !storedDuelState ||
    !duelKey ||
    marketKind !== DUEL_WINNER_MARKET_KIND
  ) {
    throw new Error("indexed lifecycle market identity is noncanonical");
  }

  const canonicalDuelState = findDuelStatePda(input.fightProgramId, duelKey);
  const canonicalMarket = PublicKey.findProgramAddressSync(
    [
      MARKET_SEED,
      canonicalDuelState.toBuffer(),
      Uint8Array.of(DUEL_WINNER_MARKET_KIND),
    ],
    input.marketProgramId,
  )[0];
  if (
    !canonicalDuelState.equals(storedDuelState) ||
    !canonicalMarket.equals(marketRef)
  ) {
    throw new Error("indexed lifecycle market identity is noncanonical");
  }

  return {
    marketRef: canonicalMarket.toBase58(),
    duelStateRef: canonicalDuelState.toBase58(),
    duelKeyHex: Buffer.from(duelKey).toString("hex"),
    marketKind: DUEL_WINNER_MARKET_KIND,
  };
}

export function requireCanonicalMarketCreationIdentity(input: {
  fightProgramId: PublicKey;
  marketProgramId: PublicKey;
  instructionDuelKey: unknown;
  instructionMarketKind: unknown;
  eventDuelKey: unknown;
  eventMarketKind: unknown;
  eventMarketRef: PublicKeyLike;
  accounts: readonly PublicKeyLike[];
  operatorSigned: boolean;
  nativeTransferCount: number;
}): CanonicalMarketCreationIdentity {
  const instructionDuelKey = exactBytes32(input.instructionDuelKey);
  const eventDuelKey = exactBytes32(input.eventDuelKey);
  const instructionMarketKind = safeAccountInteger(input.instructionMarketKind);
  const eventMarketKind = safeAccountInteger(input.eventMarketKind);
  if (
    !instructionDuelKey ||
    !eventDuelKey ||
    !Buffer.from(instructionDuelKey).equals(Buffer.from(eventDuelKey)) ||
    instructionMarketKind !== DUEL_WINNER_MARKET_KIND ||
    eventMarketKind !== instructionMarketKind ||
    input.accounts.length !== 6 ||
    input.operatorSigned !== true ||
    input.nativeTransferCount !== 0
  ) {
    throw new Error("finalized market creation identity is noncanonical");
  }

  const operator = publicKey(input.accounts[0]);
  const config = publicKey(input.accounts[1]);
  const duelState = publicKey(input.accounts[2]);
  const market = publicKey(input.accounts[3]);
  const vault = publicKey(input.accounts[4]);
  const systemProgram = publicKey(input.accounts[5]);
  const eventMarket = publicKey(input.eventMarketRef);
  if (
    !operator ||
    !config ||
    !duelState ||
    !market ||
    !vault ||
    !systemProgram ||
    !eventMarket
  ) {
    throw new Error("finalized market creation identity is noncanonical");
  }

  const identity = requireCanonicalLifecycleMarketIdentity({
    fightProgramId: input.fightProgramId,
    marketProgramId: input.marketProgramId,
    marketRef: market,
    duelState,
    duelKey: instructionDuelKey,
    marketKind: instructionMarketKind,
  });
  const canonicalConfig = PublicKey.findProgramAddressSync(
    [CONFIG_SEED],
    input.marketProgramId,
  )[0];
  const canonicalVault = PublicKey.findProgramAddressSync(
    [VAULT_SEED, market.toBuffer()],
    input.marketProgramId,
  )[0];
  if (
    !market.equals(eventMarket) ||
    !config.equals(canonicalConfig) ||
    !vault.equals(canonicalVault) ||
    !systemProgram.equals(SystemProgram.programId)
  ) {
    throw new Error("finalized market creation identity is noncanonical");
  }

  return {
    ...identity,
    operatorRef: operator.toBase58(),
    configRef: canonicalConfig.toBase58(),
    vaultRef: canonicalVault.toBase58(),
  };
}

function findDuelStatePda(
  fightProgramId: PublicKey,
  duelKey: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [DUEL_SEED, Buffer.from(duelKey)],
    fightProgramId,
  )[0];
}
