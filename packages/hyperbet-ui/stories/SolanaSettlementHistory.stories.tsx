import type { Meta, StoryObj } from "@storybook/react";
import { SolanaSettlementHistory } from "../src/components/SolanaSettlementHistory";
import { StorySurface } from "./storySupport";

const meta = {
  title: "Components/SolanaSettlementHistory",
  component: SolanaSettlementHistory,
  parameters: { chain: "solana" },
  render: (args) => (
    <StorySurface width={460}>
      <SolanaSettlementHistory {...args} />
    </StorySurface>
  ),
  args: {
    programId: "11111111111111111111111111111111",
    walletAddress: null,
    marketPda: null,
    agent1Name: "Agent One",
    agent2Name: "Agent Two",
    compact: false,
  },
} satisfies Meta<typeof SolanaSettlementHistory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Disconnected: Story = {};

export const ConnectedClaimable: Story = {
  args: {
    walletAddress: "9YQ6U3b1i3Qxb38nSxrdbidKdvUSsfx8bVsgcuyo6edS",
    compact: true,
    onRequestSettlement: () => undefined,
  },
};
