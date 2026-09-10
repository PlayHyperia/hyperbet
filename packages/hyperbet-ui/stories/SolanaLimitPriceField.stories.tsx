import type { Meta, StoryObj } from "@storybook/react";
import { useState } from "react";

import { SolanaLimitPriceField } from "../src/components/SolanaLimitPriceField";
import { StorySurface } from "./storySupport";

const meta = {
  title: "Components/SolanaLimitPriceField",
  component: SolanaLimitPriceField,
  parameters: { chain: "solana", layout: "padded" },
  render: (args) => {
    const [value, setValue] = useState(args.value);
    return (
      <StorySurface width={460}>
        <SolanaLimitPriceField {...args} value={value} onChange={setValue} />
      </StorySurface>
    );
  },
  args: {
    value: "500",
    label: "Selected-outcome limit probability (per mille)",
    helpText: "Enter a whole number from 1 to 999.",
    onChange: () => undefined,
  },
} satisfies Meta<typeof SolanaLimitPriceField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Valid: Story = {};

export const Invalid: Story = {
  args: {
    value: "1000",
    errorMessage: "Enter a whole number from 1 to 999.",
  },
};
