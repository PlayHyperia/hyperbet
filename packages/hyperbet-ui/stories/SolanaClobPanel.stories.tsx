import type { Meta, StoryObj } from "@storybook/react";
import { Connection } from "@solana/web3.js";
import { SolanaClobPanel } from "../src/components/SolanaClobPanel";
import { StorySurface } from "./storySupport";

const meta = {
  title: "Components/SolanaClobPanel",
  component: SolanaClobPanel,
  parameters: {
    chain: "solana",
  },
  render: (args) => (
    <StorySurface width={1180}>
      <SolanaClobPanel {...args} />
    </StorySurface>
  ),
  args: {
    agent1Name: "StormWarden",
    agent2Name: "JadePhoenix",
    compact: false,
    tradingEnabled: false,
    connectionOverride: new Connection("https://api.devnet.solana.com"),
    walletOverride: { publicKey: null },
    programAddresses: {
      fightOracleProgramId: "GFdnu7kUnZGiXh4ejWiJSBCUxvq4UfdEeUv9jjFzr5EM",
      duelMarketProgramId: "3QUVoaKJqo1rg9eXe7vyFewJrY75NWdtH8JZfvTb79Uy",
    },
  },
} satisfies Meta<typeof SolanaClobPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
