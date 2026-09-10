import type { Meta, StoryObj } from "@storybook/react";
import {
  SolanaTransactionFeedbackCard,
  type SolanaTransactionFeedbackState,
} from "../src/components/SolanaTransactionFeedbackCard";
import type {
  SolanaTransactionErrorKind,
  SolanaTransactionRetryMode,
  SolanaTransactionStage,
} from "../src/lib/solanaTransactionFeedback";
import { StorySurface } from "./storySupport";

const SIGNATURE =
  "5Vj9v5x5u3P5TtBczYvHh8sjv3wjfNXrjAq9LPG3GJ3c2P7n4qg3pU4y6k4cX1m7hQ9u8F6a5D2s1W3e7R9t8K2";

function failure(
  kind: SolanaTransactionErrorKind,
  stage: SolanaTransactionStage,
  retryMode: SolanaTransactionRetryMode,
  signature: string | null = null,
): SolanaTransactionFeedbackState {
  return {
    status: "error",
    signature,
    warning: null,
    recovery: {
      kind,
      stage,
      signature,
      retryMode,
      detail: `${kind} fixture`,
    },
  };
}

const meta = {
  title: "Components/SolanaTransactionFeedbackCard",
  component: SolanaTransactionFeedbackCard,
  parameters: {
    chain: "solana",
    layout: "padded",
  },
  render: (args) => (
    <StorySurface width={520}>
      <SolanaTransactionFeedbackCard {...args} />
    </StorySurface>
  ),
  args: {
    feedback: {
      status: "confirming",
      signature: SIGNATURE,
      recovery: null,
      warning: null,
    },
    message: "Transaction sent; waiting for on-chain confirmation",
    cluster: "devnet",
    testId: "storybook-transaction-feedback",
    signatureTestId: "storybook-transaction-signature",
    signatureLabel: "Transaction signature",
    detailsLabel: "Transaction proof",
    receiptLabel: "View transaction",
    reviewLabel: "Review latest quote",
    checkStatusLabel: "Check transaction status",
    onReview: () => undefined,
  },
} satisfies Meta<typeof SolanaTransactionFeedbackCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Confirming: Story = {};

export const Confirmed: Story = {
  args: {
    feedback: {
      status: "confirmed",
      signature: SIGNATURE,
      recovery: null,
      warning: null,
    },
    message: "Order confirmed on-chain",
  },
};

export const ConfirmedIndexingDelayed: Story = {
  args: {
    feedback: {
      status: "confirmed",
      signature: SIGNATURE,
      recovery: null,
      warning:
        "Activity indexing is still catching up. Do not place it again; use the signature to verify status.",
    },
    message: "Order confirmed on-chain",
  },
};

export const WalletRejected: Story = {
  args: {
    feedback: failure("USER_REJECTED", "signing", "REVIEW_AND_RETRY"),
    message:
      "Your wallet declined the signature. No transaction was sent; review the quote before trying again.",
  },
};

export const WalletDisconnected: Story = {
  args: {
    feedback: failure("WALLET_DISCONNECTED", "preparing", "REVIEW_AND_RETRY"),
    message:
      "Your wallet disconnected. Reconnect and review the latest quote before trying again.",
  },
};

export const InsufficientFunds: Story = {
  args: {
    feedback: failure("INSUFFICIENT_FUNDS", "sending", "REVIEW_AND_RETRY"),
    message:
      "Your wallet cannot cover the order, fees, and account rent. Add SOL, then review the latest quote.",
  },
};

export const ExpiredAfterSubmission: Story = {
  args: {
    feedback: failure("EXPIRED", "confirming", "CHECK_STATUS_FIRST", SIGNATURE),
    message:
      "The transaction expired and was not automatically resubmitted. Check its on-chain status before signing a new order.",
  },
};

export const RpcResponseInterrupted: Story = {
  args: {
    feedback: failure(
      "RPC_UNAVAILABLE",
      "confirming",
      "CHECK_STATUS_FIRST",
      SIGNATURE,
    ),
    message:
      "The network response was interrupted. Check the transaction before signing again.",
  },
};

export const SimulationRejected: Story = {
  args: {
    feedback: failure("SIMULATION_FAILED", "sending", "REVIEW_AND_RETRY"),
    message:
      "Transaction preflight failed and the order was not confirmed. Refresh the market and review the latest quote.",
  },
};

export const ProgramRejected: Story = {
  args: {
    feedback: failure("ONCHAIN_FAILED", "confirming", "BLOCKED", SIGNATURE),
    message:
      "The on-chain program rejected this transaction. The order did not execute; refresh the market before continuing.",
  },
};

export const UnknownOutcome: Story = {
  args: {
    feedback: failure("UNKNOWN", "sending", "CHECK_STATUS_FIRST", SIGNATURE),
    message:
      "The transaction outcome is uncertain. Check your wallet and on-chain status before signing again.",
  },
};
