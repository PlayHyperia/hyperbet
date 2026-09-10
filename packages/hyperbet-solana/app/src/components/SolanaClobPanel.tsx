import type { ComponentProps } from "react";
import {
  SolanaClobPanel as SharedSolanaClobPanel,
  type SolanaClobMarketSnapshot,
} from "@hyperbet/ui/components/SolanaClobPanel";

import { useAppConnection, useAppWallet } from "../lib/appWalletContext";
import { CONFIG } from "../lib/config";
import { resolveTransactionWallet } from "../lib/transactionAuthority";

type WrapperProps = Omit<
  ComponentProps<typeof SharedSolanaClobPanel>,
  "connectionOverride" | "walletOverride" | "programAddresses"
>;

export type { SolanaClobMarketSnapshot };

export function SolanaClobPanel(props: WrapperProps) {
  const { connection } = useAppConnection();
  const wallet = useAppWallet();
  const transactionWallet = resolveTransactionWallet(
    wallet,
    CONFIG.transactionsEnabled,
  );

  return (
    <SharedSolanaClobPanel
      {...props}
      connectionOverride={connection}
      walletOverride={transactionWallet}
      readOnly={!CONFIG.transactionsEnabled}
      programAddresses={{
        fightOracleProgramId: CONFIG.fightOracleProgramId,
        duelMarketProgramId: CONFIG.duelMarketProgramId,
      }}
    />
  );
}
