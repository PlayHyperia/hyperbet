import "./setup";
import { afterEach, describe, expect, it, mock } from "bun:test";

import { SolanaLimitPriceField } from "../src/components/SolanaLimitPriceField";
import {
  changeValue,
  cleanupRenderedTrees,
  getByTestId,
  render,
} from "./render";

afterEach(cleanupRenderedTrees);

describe("SolanaLimitPriceField", () => {
  it("exposes the exact integer constraint through its label and help text", () => {
    const onChange = mock(() => undefined);
    const { container } = render(
      <SolanaLimitPriceField
        value="500"
        label="Selected-outcome limit probability (per mille)"
        helpText="Enter a whole number from 1 to 999."
        onChange={onChange}
      />,
    );
    const input = getByTestId(
      container,
      "solana-clob-price-input",
    ) as HTMLInputElement;
    const label = container.querySelector(`label[for="${input.id}"]`);
    const help = container.querySelector(
      `#${input.getAttribute("aria-describedby")}`,
    );

    expect(label?.textContent).toBe(
      "Selected-outcome limit probability (per mille)",
    );
    expect(help?.textContent).toBe("Enter a whole number from 1 to 999.");
    expect(input.type).toBe("text");
    expect(input.inputMode).toBe("numeric");
    expect(input.maxLength).toBe(3);
    expect(input.pattern).toBe("[0-9]{1,3}");
    expect(input.style.minHeight).toBe("44px");
    expect(input.getAttribute("aria-invalid")).toBe("false");
    expect(input.hasAttribute("aria-errormessage")).toBe(false);

    changeValue(input, "650");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("650");
  });

  it("associates an invalid value with an announced field error", () => {
    const { container } = render(
      <SolanaLimitPriceField
        value="1000"
        label="Selected-outcome limit probability (per mille)"
        helpText="Enter a whole number from 1 to 999."
        errorMessage="Enter a whole number from 1 to 999."
        onChange={() => undefined}
      />,
    );
    const input = getByTestId(
      container,
      "solana-clob-price-input",
    ) as HTMLInputElement;
    const descriptionIds =
      input.getAttribute("aria-describedby")?.split(" ") ?? [];
    const errorId = input.getAttribute("aria-errormessage");

    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(descriptionIds).toHaveLength(2);
    expect(errorId).toBe(descriptionIds[1]);
    expect(container.querySelector(`#${errorId}`)?.getAttribute("role")).toBe(
      "alert",
    );
    expect(container.querySelector(`#${errorId}`)?.textContent).toBe(
      "Enter a whole number from 1 to 999.",
    );
  });
});
