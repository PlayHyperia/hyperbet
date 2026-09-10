import { type AccountInfo, type Connection, PublicKey } from "@solana/web3.js";

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111",
);

const UPGRADEABLE_PROGRAM_VARIANT = 2;
const UPGRADEABLE_PROGRAM_DATA_VARIANT = 3;
const UPGRADEABLE_PROGRAM_ACCOUNT_SIZE = 36;
const UPGRADEABLE_PROGRAM_DATA_METADATA_SIZE = 45;

export type ExpectedUpgradeAuthority = PublicKey | null | undefined;

export type VerifiedProgramIdentity = {
  programId: PublicKey;
  programDataAddress: PublicKey;
  upgradeAuthority: PublicKey | null;
  deployedSlot: bigint;
};

export function deriveProgramDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID,
  )[0];
}

export function resolveExpectedUpgradeAuthority(input: {
  value: string | undefined;
  required: boolean;
  label: string;
}): ExpectedUpgradeAuthority {
  const value = input.value?.trim();
  if (!value) {
    if (input.required) {
      throw new Error(
        `${input.label} expected upgrade authority is required for this launch rail`,
      );
    }
    return undefined;
  }
  if (value.toLowerCase() === "immutable" || value.toLowerCase() === "none") {
    return null;
  }
  const authority = new PublicKey(value);
  if (authority.equals(PublicKey.default)) {
    throw new Error(`${input.label} expected upgrade authority cannot be zero`);
  }
  return authority;
}

export function resolveClusterExpectedUpgradeAuthority(input: {
  cluster: string;
  value: string | undefined;
  label: string;
}): ExpectedUpgradeAuthority {
  const cluster = input.cluster.trim().toLowerCase();
  if (cluster === "localnet") {
    return resolveExpectedUpgradeAuthority({ ...input, required: false });
  }
  if (
    cluster !== "devnet" &&
    cluster !== "testnet" &&
    cluster !== "mainnet" &&
    cluster !== "mainnet-beta"
  ) {
    throw new Error(
      `Unsupported Solana program-identity cluster '${input.cluster}'`,
    );
  }
  return resolveExpectedUpgradeAuthority({ ...input, required: true });
}

function parseProgramDataAddress(data: Buffer): PublicKey {
  if (
    data.length !== UPGRADEABLE_PROGRAM_ACCOUNT_SIZE ||
    data.readUInt32LE(0) !== UPGRADEABLE_PROGRAM_VARIANT
  ) {
    throw new Error("program account has an invalid upgradeable-loader layout");
  }
  return new PublicKey(data.subarray(4, 36));
}

function parseProgramDataMetadata(data: Buffer): {
  deployedSlot: bigint;
  upgradeAuthority: PublicKey | null;
} {
  if (
    data.length < 13 ||
    data.readUInt32LE(0) !== UPGRADEABLE_PROGRAM_DATA_VARIANT
  ) {
    throw new Error("ProgramData account has an invalid loader layout");
  }
  const deployedSlot = data.readBigUInt64LE(4);
  const authorityTag = data.readUInt8(12);
  if (authorityTag === 0) {
    return { deployedSlot, upgradeAuthority: null };
  }
  if (
    authorityTag !== 1 ||
    data.length < UPGRADEABLE_PROGRAM_DATA_METADATA_SIZE
  ) {
    throw new Error("ProgramData account has an invalid authority layout");
  }
  return {
    deployedSlot,
    upgradeAuthority: new PublicKey(data.subarray(13, 45)),
  };
}

export function verifyUpgradeableProgramIdentity(input: {
  label: string;
  programId: PublicKey;
  programAccount: AccountInfo<Buffer> | null;
  programDataAccount: AccountInfo<Buffer> | null;
  expectedUpgradeAuthority: ExpectedUpgradeAuthority;
}): VerifiedProgramIdentity {
  const { label, programId, programAccount, programDataAccount } = input;
  if (!programAccount) {
    throw new Error(
      `${label} program account ${programId.toBase58()} is absent`,
    );
  }
  if (!programAccount.executable) {
    throw new Error(
      `${label} program account ${programId.toBase58()} is not executable`,
    );
  }
  if (!programAccount.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
    throw new Error(`${label} program is not owned by the upgradeable loader`);
  }

  const linkedProgramDataAddress = parseProgramDataAddress(programAccount.data);
  const canonicalProgramDataAddress = deriveProgramDataAddress(programId);
  if (!linkedProgramDataAddress.equals(canonicalProgramDataAddress)) {
    throw new Error(`${label} program links to non-canonical ProgramData`);
  }
  if (!programDataAccount) {
    throw new Error(
      `${label} ProgramData account ${canonicalProgramDataAddress.toBase58()} is absent`,
    );
  }
  if (programDataAccount.executable) {
    throw new Error(`${label} ProgramData account must not be executable`);
  }
  if (!programDataAccount.owner.equals(BPF_LOADER_UPGRADEABLE_PROGRAM_ID)) {
    throw new Error(
      `${label} ProgramData is not owned by the upgradeable loader`,
    );
  }

  const metadata = parseProgramDataMetadata(programDataAccount.data);
  if (input.expectedUpgradeAuthority !== undefined) {
    const expected = input.expectedUpgradeAuthority;
    const matches =
      expected === null
        ? metadata.upgradeAuthority === null
        : metadata.upgradeAuthority?.equals(expected) === true;
    if (!matches) {
      throw new Error(
        `${label} upgrade authority does not match the required launch identity`,
      );
    }
  }

  return {
    programId,
    programDataAddress: canonicalProgramDataAddress,
    upgradeAuthority: metadata.upgradeAuthority,
    deployedSlot: metadata.deployedSlot,
  };
}

export async function fetchUpgradeableProgramIdentity(input: {
  connection: Connection;
  label: string;
  programId: PublicKey;
  expectedUpgradeAuthority: ExpectedUpgradeAuthority;
}): Promise<VerifiedProgramIdentity> {
  const programAccount = await input.connection.getAccountInfo(
    input.programId,
    "finalized",
  );
  const programDataAddress = deriveProgramDataAddress(input.programId);
  const programDataAccount = await input.connection.getAccountInfo(
    programDataAddress,
    "finalized",
  );
  return verifyUpgradeableProgramIdentity({
    ...input,
    programAccount,
    programDataAccount,
  });
}
