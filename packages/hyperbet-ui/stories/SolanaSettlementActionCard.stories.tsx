import type { Meta, StoryObj } from "@storybook/react";

import { SolanaSettlementActionCard } from "../src/components/SolanaSettlementActionCard";
import { StorySurface } from "./storySupport";

const meta = {
  title: "Components/SolanaSettlementActionCard",
  component: SolanaSettlementActionCard,
  parameters: {
    chain: "solana",
  },
  render: (args) => (
    <StorySurface width={420}>
      <SolanaSettlementActionCard {...args} />
    </StorySurface>
  ),
  args: {
    kind: "winnings",
    eyebrow: "Winnings ready",
    title: "Claim winnings",
    helpText:
      "The duel is final. Claim the SOL secured by your winning shares.",
    amountLabel: "Claimable now",
    amountText: "1.425 SOL",
    buttonLabel: "Claim 1.425 SOL",
    processingLabel: "Processing…",
    isProcessing: false,
    disabled: false,
    onAction: () => undefined,
  },
} satisfies Meta<typeof SolanaSettlementActionCard>;

export default meta;

type Story = StoryObj<typeof meta>;

export const WinnerClaim: Story = {};

export const CancellationRefund: Story = {
  args: {
    kind: "refund",
    eyebrow: "Refund ready",
    title: "Claim refund",
    helpText:
      "This duel was cancelled. Your settled stake is available to return to your wallet.",
    amountText: "0.800 SOL",
    buttonLabel: "Claim 0.800 SOL",
  },
};

export const LosingPositionCleanup: Story = {
  args: {
    kind: "cleanup",
    eyebrow: "Cleanup required",
    title: "Clear resolved position",
    helpText:
      "This position did not win and has no payout. Clear its resolved on-chain state to finish settlement.",
    amountText: null,
    buttonLabel: "Clear position",
  },
};

export const AccountRentRecovery: Story = {
  args: {
    kind: "rent",
    eyebrow: "Rent recovery",
    title: "Recover account rent",
    helpText:
      "This market holds no remaining funds. Recover the SOL reserved for the empty balance account.",
    amountText: null,
    buttonLabel: "Recover rent",
  },
};

export const Processing: Story = {
  args: {
    isProcessing: true,
  },
};
