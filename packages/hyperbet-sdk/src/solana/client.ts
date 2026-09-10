import { AnchorProvider, Program, Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountMeta,
} from "@solana/web3.js";

import {
  type CancelOrderParams,
  type ClaimParams,
  type CloseFilledOrderParams,
  type CloseLosingBalanceParams,
  type CreateOrderParams,
  MARKET_KIND_DUEL_WINNER,
  MAX_MATCHES_PER_TRANSACTION,
  ORDER_BEHAVIOR_GTC,
  ORDER_BEHAVIOR_IOC,
  ORDER_BEHAVIOR_POST_ONLY,
  type ReclaimOrderParams,
  SIDE_ASK,
  SIDE_BID,
  type SolanaOrderBehavior,
  type SolanaOutcomeSide,
} from "../types";

import duelMarketIdl from "./idl/duel_market.json" assert { type: "json" };
import fightOracleIdl from "./idl/fight_oracle.json" assert { type: "json" };

const MAX_U64 = 18_446_744_073_709_551_615n;

type MarketContext = {
  duelState: PublicKey;
  marketState: PublicKey;
  marketAccount: any;
};

// Anchor 0.30.1's root declaration drops the inherited NodeWallet constructor
// under TypeScript's bundler resolution even though the runtime class accepts
// a Keypair. Preserve that exact runtime contract without weakening the
// provider wallet type.
type AnchorWalletConstructor = new (payer: Keypair) => AnchorProvider["wallet"];

function assertRpcUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Solana RPC URL must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Solana RPC URL must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Solana RPC URL must not contain credentials");
  }
  return url.href;
}

function idlAtAddress(idl: unknown, programId: PublicKey): any {
  return {
    ...(idl as Record<string, unknown>),
    address: programId.toBase58(),
  };
}

function asBigInt(value: unknown, label: string): bigint {
  try {
    const parsed = BigInt(
      typeof value === "object" && value !== null && "toString" in value
        ? String(value)
        : (value as string | number | bigint),
    );
    if (parsed < 0n || parsed > MAX_U64) {
      throw new Error();
    }
    return parsed;
  } catch {
    throw new Error(`${label} is not a valid program u64`);
  }
}

function asProgramInteger(value: unknown, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} is not a valid program integer`);
  }
  return parsed;
}

function publicKey(value: unknown, label: string): PublicKey {
  try {
    return value instanceof PublicKey ? value : new PublicKey(String(value));
  } catch {
    throw new Error(`${label} is not a valid Solana address`);
  }
}

function enumName(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  return Object.keys(value as Record<string, unknown>)[0]?.toLowerCase() ?? "";
}

function assertOrderId(value: bigint): void {
  if (value < 0n || value > MAX_U64) {
    throw new Error("Order ID is outside the program u64 range");
  }
}

function normalizeOrderInput(input: CreateOrderParams): {
  side: number;
  price: number;
  amount: bigint;
  behavior: number;
} {
  if (
    !Number.isInteger(input.outcomePriceMillis) ||
    input.outcomePriceMillis <= 0 ||
    input.outcomePriceMillis >= 1_000
  ) {
    throw new Error("Outcome probability must be an integer from 1 to 999");
  }
  if (
    input.amountLamports <= 0n ||
    input.amountLamports > MAX_U64 ||
    input.amountLamports % 1_000n !== 0n
  ) {
    throw new Error(
      "Order amount must be a positive program u64 divisible by 1000 lamports",
    );
  }
  const side = input.side === "YES" ? SIDE_BID : SIDE_ASK;
  const price =
    input.side === "YES"
      ? input.outcomePriceMillis
      : 1_000 - input.outcomePriceMillis;
  const behavior = orderBehaviorValue(input.behavior ?? "GTC");
  return { side, price, amount: input.amountLamports, behavior };
}

function orderBehaviorValue(behavior: SolanaOrderBehavior): number {
  switch (behavior) {
    case "GTC":
      return ORDER_BEHAVIOR_GTC;
    case "IOC":
      return ORDER_BEHAVIOR_IOC;
    case "POST_ONLY":
      return ORDER_BEHAVIOR_POST_ONLY;
  }
}

export function duelKeyHexToBytes(duelKeyHex: string): Uint8Array {
  const normalized = duelKeyHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("duelKeyHex must be a 32-byte hex string");
  }
  return Uint8Array.from(Buffer.from(normalized, "hex"));
}

export function findDuelStatePda(
  fightOracleProgramId: PublicKey,
  duelKey: Uint8Array,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("duel"), Buffer.from(duelKey)],
    fightOracleProgramId,
  )[0];
}

export function findMarketStatePda(
  duelMarketProgramId: PublicKey,
  duelState: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("market"),
      duelState.toBuffer(),
      Uint8Array.of(MARKET_KIND_DUEL_WINNER),
    ],
    duelMarketProgramId,
  )[0];
}

export function findMarketConfigPda(duelMarketProgramId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("config")],
    duelMarketProgramId,
  )[0];
}

export function findVaultPda(
  duelMarketProgramId: PublicKey,
  marketState: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), marketState.toBuffer()],
    duelMarketProgramId,
  )[0];
}

export function findUserBalancePda(
  duelMarketProgramId: PublicKey,
  marketState: PublicKey,
  owner: PublicKey,
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("balance"), marketState.toBuffer(), owner.toBuffer()],
    duelMarketProgramId,
  )[0];
}

export function findOrderPda(
  duelMarketProgramId: PublicKey,
  marketState: PublicKey,
  orderId: bigint,
): PublicKey {
  assertOrderId(orderId);
  const orderIdBytes = Buffer.alloc(8);
  orderIdBytes.writeBigUInt64LE(orderId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("order"), marketState.toBuffer(), orderIdBytes],
    duelMarketProgramId,
  )[0];
}

export function findPriceLevelPda(
  duelMarketProgramId: PublicKey,
  marketState: PublicKey,
  side: number,
  price: number,
): PublicKey {
  if (![SIDE_BID, SIDE_ASK].includes(side)) {
    throw new Error("Order side must be the program bid or ask value");
  }
  if (!Number.isInteger(price) || price <= 0 || price >= 1_000) {
    throw new Error("Program price must be an integer from 1 to 999");
  }
  const priceBytes = Buffer.alloc(2);
  priceBytes.writeUInt16LE(price);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("level"),
      marketState.toBuffer(),
      Uint8Array.of(side),
      priceBytes,
    ],
    duelMarketProgramId,
  )[0];
}

export class HyperbetSolanaClient {
  public readonly connection: Connection;
  public readonly wallet: Keypair;
  public readonly provider: AnchorProvider;
  public readonly duelMarketProgram: Program;
  public readonly fightOracleProgram: Program;
  public readonly duelMarketProgramId: PublicKey;
  public readonly fightOracleProgramId: PublicKey;

  constructor(
    rpcUrl: string,
    privateKeyBase58: string,
    duelMarketProgramId: string,
    fightOracleProgramId: string,
  ) {
    this.connection = new Connection(assertRpcUrl(rpcUrl), "confirmed");
    this.wallet = Keypair.fromSecretKey(bs58.decode(privateKeyBase58));
    this.duelMarketProgramId = new PublicKey(duelMarketProgramId);
    this.fightOracleProgramId = new PublicKey(fightOracleProgramId);
    this.provider = new AnchorProvider(
      this.connection,
      new (Wallet as unknown as AnchorWalletConstructor)(this.wallet),
      {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      },
    );
    this.duelMarketProgram = new Program(
      idlAtAddress(duelMarketIdl, this.duelMarketProgramId),
      this.provider,
    );
    this.fightOracleProgram = new Program(
      idlAtAddress(fightOracleIdl, this.fightOracleProgramId),
      this.provider,
    );
  }

  public getDuelStatePda(duelKey: Uint8Array): PublicKey {
    return findDuelStatePda(this.fightOracleProgramId, duelKey);
  }

  public getMarketPda(duelState: PublicKey): PublicKey {
    return findMarketStatePda(this.duelMarketProgramId, duelState);
  }

  public getMarketConfigPda(): PublicKey {
    return findMarketConfigPda(this.duelMarketProgramId);
  }

  public getVaultPda(marketState: PublicKey): PublicKey {
    return findVaultPda(this.duelMarketProgramId, marketState);
  }

  public getUserBalancePda(marketState: PublicKey): PublicKey {
    return findUserBalancePda(
      this.duelMarketProgramId,
      marketState,
      this.wallet.publicKey,
    );
  }

  private async resolveMarket(duelKeyHex: string): Promise<MarketContext> {
    const duelState = this.getDuelStatePda(duelKeyHexToBytes(duelKeyHex));
    const marketState = this.getMarketPda(duelState);
    const [duelAccount, marketAccount] = await Promise.all([
      (this.fightOracleProgram as any).account.duelState.fetch(duelState),
      (this.duelMarketProgram as any).account.marketState.fetch(marketState),
    ]);
    if (!duelAccount) {
      throw new Error("Canonical duel account is unavailable");
    }
    const storedDuelState = publicKey(
      marketAccount.duelState,
      "Market duel state",
    );
    if (!storedDuelState.equals(duelState)) {
      throw new Error("Market does not reference the canonical duel PDA");
    }
    if (
      asProgramInteger(marketAccount.marketKind, "Market kind") !==
      MARKET_KIND_DUEL_WINNER
    ) {
      throw new Error("Market is not the canonical duel-winner market");
    }
    return { duelState, marketState, marketAccount };
  }

  private async buildPlaceOrderRemainingAccounts(input: {
    marketState: PublicKey;
    side: number;
    price: number;
    amount: bigint;
    behavior: number;
  }): Promise<AccountMeta[]> {
    const oppositeSide = input.side === SIDE_BID ? SIDE_ASK : SIDE_BID;
    const allLevels = await (
      this.duelMarketProgram as any
    ).account.priceLevel.all();
    const levels = allLevels
      .filter((entry: any) => {
        const accountMarket = publicKey(
          entry.account.marketState,
          "Price-level market",
        );
        const side = asProgramInteger(entry.account.side, "Price-level side");
        const price = asProgramInteger(
          entry.account.price,
          "Price-level price",
        );
        return (
          accountMarket.equals(input.marketState) &&
          side === oppositeSide &&
          asBigInt(entry.account.totalOpen, "Price-level open amount") > 0n &&
          (input.side === SIDE_BID
            ? price <= input.price
            : price >= input.price)
        );
      })
      .sort((left: any, right: any) => {
        const leftPrice = Number(left.account.price);
        const rightPrice = Number(right.account.price);
        return input.side === SIDE_BID
          ? leftPrice - rightPrice
          : rightPrice - leftPrice;
      });

    const metas: AccountMeta[] = [];
    let remaining = input.amount;
    let matches = 0;
    let selfTradePrevented = false;

    for (const levelEntry of levels) {
      if (remaining <= 0n || matches >= MAX_MATCHES_PER_TRANSACTION) break;
      const level = levelEntry.account;
      const levelPrice = asProgramInteger(level.price, "Price-level price");
      const levelPda = findPriceLevelPda(
        this.duelMarketProgramId,
        input.marketState,
        oppositeSide,
        levelPrice,
      );
      const returnedLevelKey = publicKey(
        levelEntry.publicKey,
        "Price-level account",
      );
      if (!returnedLevelKey.equals(levelPda)) {
        throw new Error("Price-level account does not match its canonical PDA");
      }
      metas.push({ pubkey: levelPda, isSigner: false, isWritable: true });

      let currentOrderId = asBigInt(level.headOrderId, "Price-level head");
      let levelOpen = asBigInt(level.totalOpen, "Price-level open amount");
      if (currentOrderId === 0n || levelOpen === 0n) {
        throw new Error("Active price level has an empty linked-list boundary");
      }

      while (
        remaining > 0n &&
        currentOrderId > 0n &&
        levelOpen > 0n &&
        matches < MAX_MATCHES_PER_TRANSACTION
      ) {
        const orderPda = findOrderPda(
          this.duelMarketProgramId,
          input.marketState,
          currentOrderId,
        );
        const order = await (this.duelMarketProgram as any).account.order.fetch(
          orderPda,
        );
        if (
          !publicKey(order.marketState, "Order market").equals(
            input.marketState,
          ) ||
          asBigInt(order.id, "Order ID") !== currentOrderId ||
          asProgramInteger(order.side, "Order side") !== oppositeSide ||
          asProgramInteger(order.price, "Order price") !== levelPrice ||
          !order.active
        ) {
          throw new Error("Order book changed while building the transaction");
        }
        const maker = publicKey(order.maker, "Order maker");
        const makerBalance = findUserBalancePda(
          this.duelMarketProgramId,
          input.marketState,
          maker,
        );
        metas.push(
          { pubkey: orderPda, isSigner: false, isWritable: true },
          { pubkey: makerBalance, isSigner: false, isWritable: true },
        );

        if (maker.equals(this.wallet.publicKey)) {
          selfTradePrevented = true;
          break;
        }
        const amount = asBigInt(order.amount, "Order amount");
        const filled = asBigInt(order.filled, "Order filled amount");
        if (filled >= amount) {
          throw new Error("Active order has no remaining amount");
        }
        const orderRemaining = amount - filled;
        const fill = orderRemaining < remaining ? orderRemaining : remaining;
        remaining -= fill;
        levelOpen -= fill;
        matches += 1;
        if (remaining <= 0n || fill < orderRemaining) break;

        currentOrderId = asBigInt(order.nextOrderId, "Next order ID");
        if (currentOrderId > 0n && levelOpen > 0n) {
          metas.push({ pubkey: levelPda, isSigner: false, isWritable: true });
        } else if (currentOrderId !== 0n || levelOpen !== 0n) {
          throw new Error("Price-level linked-list totals are inconsistent");
        }
      }
      if (selfTradePrevented) break;
    }

    const shouldRest =
      remaining > 0n &&
      !selfTradePrevented &&
      matches < MAX_MATCHES_PER_TRANSACTION &&
      input.behavior !== ORDER_BEHAVIOR_IOC;
    if (shouldRest) {
      const restingLevelPda = findPriceLevelPda(
        this.duelMarketProgramId,
        input.marketState,
        input.side,
        input.price,
      );
      const restingLevel = await (
        this.duelMarketProgram as any
      ).account.priceLevel.fetchNullable(restingLevelPda);
      if (restingLevel) {
        const tailOrderId = asBigInt(
          restingLevel.tailOrderId,
          "Resting price-level tail",
        );
        if (tailOrderId > 0n) {
          metas.push({
            pubkey: findOrderPda(
              this.duelMarketProgramId,
              input.marketState,
              tailOrderId,
            ),
            isSigner: false,
            isWritable: true,
          });
        }
      }
    }
    return metas;
  }

  public async placeOrder(input: CreateOrderParams): Promise<string> {
    const normalized = normalizeOrderInput(input);
    const { duelState, marketState, marketAccount } = await this.resolveMarket(
      input.duelKeyHex,
    );
    if (enumName(marketAccount.status) !== "open") {
      throw new Error("Market is not open for order placement");
    }
    const orderId = asBigInt(marketAccount.nextOrderId, "Next order ID");
    const userBalance = this.getUserBalancePda(marketState);
    const newOrder = findOrderPda(
      this.duelMarketProgramId,
      marketState,
      orderId,
    );
    const restingLevel = findPriceLevelPda(
      this.duelMarketProgramId,
      marketState,
      normalized.side,
      normalized.price,
    );
    const remainingAccounts = await this.buildPlaceOrderRemainingAccounts({
      marketState,
      ...normalized,
    });

    return (this.duelMarketProgram as any).methods
      .placeOrder(
        new BN(orderId.toString()),
        normalized.side,
        normalized.price,
        new BN(normalized.amount.toString()),
        normalized.behavior,
      )
      .accountsPartial({
        marketState,
        duelState,
        userBalance,
        newOrder,
        restingLevel,
        config: this.getMarketConfigPda(),
        treasury: publicKey(marketAccount.treasury, "Market treasury"),
        marketMaker: publicKey(
          marketAccount.marketMaker,
          "Market maker recipient",
        ),
        vault: this.getVaultPda(marketState),
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .rpc();
  }

  private async buildManagedOrderContext(input: {
    duelKeyHex: string;
    orderId: bigint;
  }): Promise<
    MarketContext & {
      order: any;
      orderPda: PublicKey;
      priceLevelPda: PublicKey;
      side: number;
      price: number;
      adjacentAccounts: AccountMeta[];
    }
  > {
    assertOrderId(input.orderId);
    const market = await this.resolveMarket(input.duelKeyHex);
    const orderPda = findOrderPda(
      this.duelMarketProgramId,
      market.marketState,
      input.orderId,
    );
    const order = await (this.duelMarketProgram as any).account.order.fetch(
      orderPda,
    );
    const side = asProgramInteger(order.side, "Order side");
    const price = asProgramInteger(order.price, "Order price");
    if (
      asBigInt(order.id, "Order ID") !== input.orderId ||
      !publicKey(order.marketState, "Order market").equals(
        market.marketState,
      ) ||
      !publicKey(order.maker, "Order maker").equals(this.wallet.publicKey) ||
      !order.active
    ) {
      throw new Error("Order is not an active order owned by this wallet");
    }
    const priceLevelPda = findPriceLevelPda(
      this.duelMarketProgramId,
      market.marketState,
      side,
      price,
    );
    const level = await (
      this.duelMarketProgram as any
    ).account.priceLevel.fetch(priceLevelPda);
    if (
      !publicKey(level.marketState, "Price-level market").equals(
        market.marketState,
      ) ||
      asProgramInteger(level.side, "Price-level side") !== side ||
      asProgramInteger(level.price, "Price-level price") !== price
    ) {
      throw new Error("Price level no longer matches the selected order");
    }

    const previousOrderId = asBigInt(order.prevOrderId, "Previous order ID");
    const nextOrderId = asBigInt(order.nextOrderId, "Next order ID");
    const adjacentAccounts: AccountMeta[] = [];
    for (const adjacentOrderId of [previousOrderId, nextOrderId]) {
      if (adjacentOrderId === 0n) continue;
      const adjacentPda = findOrderPda(
        this.duelMarketProgramId,
        market.marketState,
        adjacentOrderId,
      );
      const adjacent = await (
        this.duelMarketProgram as any
      ).account.order.fetch(adjacentPda);
      if (
        asBigInt(adjacent.id, "Adjacent order ID") !== adjacentOrderId ||
        !publicKey(adjacent.marketState, "Adjacent order market").equals(
          market.marketState,
        ) ||
        asProgramInteger(adjacent.side, "Adjacent order side") !== side ||
        asProgramInteger(adjacent.price, "Adjacent order price") !== price ||
        !adjacent.active
      ) {
        throw new Error("Linked order changed while building the transaction");
      }
      if (
        (adjacentOrderId === previousOrderId &&
          asBigInt(adjacent.nextOrderId, "Previous order link") !==
            input.orderId) ||
        (adjacentOrderId === nextOrderId &&
          asBigInt(adjacent.prevOrderId, "Next order link") !== input.orderId)
      ) {
        throw new Error("Linked order no longer references the selected order");
      }
      adjacentAccounts.push({
        pubkey: adjacentPda,
        isSigner: false,
        isWritable: true,
      });
    }
    return {
      ...market,
      order,
      orderPda,
      priceLevelPda,
      side,
      price,
      adjacentAccounts,
    };
  }

  private async submitOrderAction(
    input: CancelOrderParams | ReclaimOrderParams,
    action: "cancel" | "reclaim",
  ): Promise<string> {
    const context = await this.buildManagedOrderContext(input);
    const builder =
      action === "cancel"
        ? (this.duelMarketProgram as any).methods.cancelOrder(
            new BN(input.orderId.toString()),
            context.side,
            context.price,
          )
        : (this.duelMarketProgram as any).methods.reclaimRestingOrder(
            new BN(input.orderId.toString()),
            context.side,
            context.price,
          );
    return builder
      .accountsPartial({
        marketState: context.marketState,
        duelState: context.duelState,
        order: context.orderPda,
        priceLevel: context.priceLevelPda,
        vault: this.getVaultPda(context.marketState),
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(context.adjacentAccounts)
      .rpc();
  }

  public cancelOrder(input: CancelOrderParams): Promise<string> {
    return this.submitOrderAction(input, "cancel");
  }

  public reclaimOrder(input: ReclaimOrderParams): Promise<string> {
    return this.submitOrderAction(input, "reclaim");
  }

  public async closeFilledOrder(
    input: CloseFilledOrderParams,
  ): Promise<string> {
    assertOrderId(input.orderId);
    const { marketState } = await this.resolveMarket(input.duelKeyHex);
    const order = findOrderPda(
      this.duelMarketProgramId,
      marketState,
      input.orderId,
    );
    const orderAccount = await (
      this.duelMarketProgram as any
    ).account.order.fetch(order);
    if (
      !publicKey(orderAccount.maker, "Order maker").equals(
        this.wallet.publicKey,
      ) ||
      orderAccount.active ||
      asBigInt(orderAccount.filled, "Filled amount") !==
        asBigInt(orderAccount.amount, "Order amount") ||
      asBigInt(orderAccount.prevOrderId, "Previous order ID") !== 0n ||
      asBigInt(orderAccount.nextOrderId, "Next order ID") !== 0n ||
      Boolean(orderAccount.continuationPending)
    ) {
      throw new Error("Order is not eligible for filled-order rent cleanup");
    }
    return (this.duelMarketProgram as any).methods
      .closeFilledOrder(new BN(input.orderId.toString()))
      .accountsPartial({
        marketState,
        order,
        user: this.wallet.publicKey,
      })
      .rpc();
  }

  public async claim(input: ClaimParams): Promise<string> {
    const { duelState, marketState, marketAccount } = await this.resolveMarket(
      input.duelKeyHex,
    );
    return (this.duelMarketProgram as any).methods
      .claim()
      .accountsPartial({
        marketState,
        duelState,
        userBalance: this.getUserBalancePda(marketState),
        config: this.getMarketConfigPda(),
        marketMaker: publicKey(
          marketAccount.marketMaker,
          "Market maker recipient",
        ),
        vault: this.getVaultPda(marketState),
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
  }

  public async closeLosingBalance(
    input: CloseLosingBalanceParams,
  ): Promise<string> {
    const { duelState, marketState } = await this.resolveMarket(
      input.duelKeyHex,
    );
    return (this.duelMarketProgram as any).methods
      .closeLosingBalance()
      .accountsPartial({
        marketState,
        duelState,
        userBalance: this.getUserBalancePda(marketState),
        user: this.wallet.publicKey,
      })
      .rpc();
  }
}
