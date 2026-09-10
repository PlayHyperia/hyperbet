import type { Meta, StoryObj } from "@storybook/react";

import { SolanaOrderQuoteNotice } from "../src/components/SolanaOrderQuoteNotice";
import { StorySurface } from "./storySupport";

const meta = {
  title: "Components/SolanaOrderQuoteNotice",
  component: SolanaOrderQuoteNotice,
  parameters: { chain: "solana", layout: "padded" },
  render: (args) => (
    <StorySurface width={460}>
      <SolanaOrderQuoteNotice {...args} />
    </StorySurface>
  ),
  args: {
    kind: "loading",
    message: "Checking network fees, account rent, and wallet balance…",
  },
} satisfies Meta<typeof SolanaOrderQuoteNotice>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {};

export const SetupRequired: Story = {
  args: {
    kind: "status",
    message:
      "The market vault must be initialized before this order can be signed.",
  },
};

export const FundingError: Story = {
  args: {
    kind: "error",
    message:
      "The connected wallet cannot cover this order and its network costs.",
  },
};
