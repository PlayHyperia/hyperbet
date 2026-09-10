import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

type WalletSelectionConnector = {
  id: string;
  name: string;
  icon?: string;
  ready?: boolean;
};

export type WalletSelectionModalState = {
  isOpen: boolean;
  close: () => void;
  connect: (
    connectorId: string,
    options: { allowInteractiveFallback: boolean },
  ) => Promise<unknown>;
  connecting: boolean;
  connectors: readonly WalletSelectionConnector[];
};

export function WalletSelectionModal({
  state,
}: {
  state: WalletSelectionModalState;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const [connectError, setConnectError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.isOpen) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focusTimer = window.setTimeout(() => {
      const firstAction = dialogRef.current?.querySelector<HTMLElement>(
        "button:not([disabled])",
      );
      firstAction?.focus();
    }, 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      previousFocusRef.current?.focus();
    };
  }, [state.isOpen]);

  if (!state.isOpen) return null;

  const close = () => {
    setConnectError(null);
    state.close();
  };

  const connect = async (connectorId: string) => {
    setConnectError(null);
    try {
      await state.connect(connectorId, {
        allowInteractiveFallback: true,
      });
    } catch {
      setConnectError(
        "The wallet connection did not complete. Check the wallet window and try again.",
      );
    }
  };

  const trapDialogKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "Tab") return;
    const actions = Array.from(
      dialogRef.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ) ?? [],
    );
    if (actions.length === 0) {
      event.preventDefault();
      return;
    }
    const first = actions[0];
    const last = actions[actions.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="wallet-modal-overlay" onClick={close}>
      <div className="wallet-modal-container">
        <div
          aria-describedby={descriptionId}
          aria-labelledby={titleId}
          aria-modal="true"
          className="wallet-modal-wrapper"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={trapDialogKeyboard}
          ref={dialogRef}
          role="dialog"
        >
          <button
            aria-label="Close wallet selector"
            className="wallet-modal-button-close"
            onClick={close}
            type="button"
          >
            <span aria-hidden="true">x</span>
          </button>
          <h2 className="wallet-modal-title" id={titleId}>
            Connect Solana Wallet
          </h2>
          <p className="wallet-modal-description" id={descriptionId}>
            Choose a wallet to review and sign native SOL transactions.
          </p>
          {connectError ? (
            <p className="wallet-modal-error" role="alert">
              {connectError}
            </p>
          ) : null}
          {state.connectors.length === 0 ? (
            <p className="wallet-modal-error" role="status">
              No compatible Solana wallet was detected.
            </p>
          ) : null}
          <ul className="wallet-modal-list">
            {state.connectors.map((connector) => {
              const disabled = state.connecting || connector.ready === false;
              return (
                <li key={connector.id}>
                  <button
                    className="wallet-button"
                    disabled={disabled}
                    onClick={() => void connect(connector.id)}
                    type="button"
                  >
                    {connector.icon ? (
                      <span className="wallet-button-start-icon">
                        <img alt="" src={connector.icon} />
                      </span>
                    ) : null}
                    <span className="wallet-button-label">
                      {connector.name}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
