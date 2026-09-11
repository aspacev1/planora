import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmAction } from "./ConfirmAction";
import { renderWithProviders } from "../test/utils";

function renderAction(onConfirm = vi.fn(), disabled = false) {
  renderWithProviders(
    <ConfirmAction
      label="Отозвать"
      warning="Ссылка перестанет работать"
      confirm="Да, отозвать"
      onConfirm={onConfirm}
      disabled={disabled}
    />,
    { locale: "ru" },
  );
  return onConfirm;
}

describe("подтверждение на месте", () => {
  it("первое нажатие ничего не делает, а называет последствие", async () => {
    const onConfirm = renderAction();

    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByText("Ссылка перестанет работать")).toBeInTheDocument();
    // The confirm button names the action rather than answering "yes, continue": in a list of three
    // buttons in a row a "yes" would apply to any of them.
    expect(screen.getByRole("button", { name: "Да, отозвать" })).toBeInTheDocument();
  });

  it("отказ возвращает кнопку и не трогает действие", async () => {
    const onConfirm = renderAction();

    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    await userEvent.click(screen.getByRole("button", { name: "Отмена" }));

    expect(onConfirm).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Отозвать" })).toBeInTheDocument();
    expect(screen.queryByText("Ссылка перестанет работать")).not.toBeInTheDocument();
  });

  it("подтверждение выполняет действие и сворачивает вопрос", async () => {
    const onConfirm = renderAction();

    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));
    await userEvent.click(screen.getByRole("button", { name: "Да, отозвать" }));

    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Отозвать" })).toBeInTheDocument();
  });

  it("фокус переходит на саму выноску, а не на подтверждение", async () => {
    renderAction();

    // The button disappears together with the press, and without a transfer the focus would fall to the
    // top of the page: the question would be unreachable from the keyboard. There is deliberately no
    // focus on the confirmation — an Enter pressed out of inertia must not confirm what was only just
    // asked about.
    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));

    const group = screen.getByRole("group", { name: "Ссылка перестанет работать" });
    expect(group).toHaveFocus();
    expect(screen.getByRole("button", { name: "Да, отозвать" })).not.toHaveFocus();
  });

  it("занятое действие не подтверждается дважды", async () => {
    const onConfirm = renderAction(vi.fn(), true);

    // The button is disabled from the start: while the request is in flight a second one like it will
    // improve nothing, while a reissue would repeat twice.
    expect(screen.getByRole("button", { name: "Отозвать" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Отозвать" }));

    expect(onConfirm).not.toHaveBeenCalled();
  });
});
