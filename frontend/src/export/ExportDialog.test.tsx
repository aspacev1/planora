import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ApiError } from "../api/client";
import type { DownloadedFile } from "../api/client";
import type { ExportOptions } from "../api/export";
import { ToastProvider } from "../components/toast";
import { renderWithProviders } from "../test/utils";
import { ExportDialog } from "./ExportDialog";
import type { ExportFacts } from "./ExportDialog";

const FACTS: ExportFacts = {
  projectName: "Переезд офиса",
  start: "2026-06-01",
  end: "2026-10-14",
  today: "2026-08-29",
  dated: true,
  tasks: 18,
  categories: 4,
  links: 19,
  comments: 4,
  proposalLines: 9,
  scorecardMetrics: 8,
  historyEvents: 12,
  internalAllowed: true,
};

type Download = (options: ExportOptions) => Promise<DownloadedFile>;

function show(facts: Partial<ExportFacts> = {}, download?: Download) {
  const onClose = vi.fn();
  const fallback: Download = async () => ({
    blob: new Blob(["x"]),
    filename: "план.pdf",
  });
  renderWithProviders(
    <ToastProvider>
      <ExportDialog
        facts={{ ...FACTS, ...facts }}
        onClose={onClose}
        download={download ?? fallback}
      />
    </ToastProvider>,
    { locale: "ru" },
  );
  return { onClose };
}

describe("окно экспорта", () => {
  it("предлагает разделы с тем, сколько в них содержимого", () => {
    show();
    expect(screen.getByText("Связей: 19")).toBeInTheDocument();
    expect(screen.getByText("Позиций: 9")).toBeInTheDocument();
  });

  it("пустой раздел недоступен — и объясняет, почему", () => {
    show({ proposalLines: 0 });

    const checkbox = screen.getByRole("checkbox", { name: /Предложение/ });
    expect(checkbox).toBeDisabled();
    // Не молча выключенная галочка, а причина: иначе человек решит, что
    // выгрузка сломана.
    expect(screen.getByText("В проекте этого нет")).toBeInTheDocument();
  });

  it("внутренние разделы не предлагаются тому, кому они не обещаны", () => {
    show({ internalAllowed: false });
    expect(screen.queryByRole("checkbox", { name: /История правок/ })).toBeNull();
  });

  it("на кнопке масштаба написано, во сколько страниц он обойдётся", () => {
    show();
    // Проект в 136 дней: день — две страницы, неделя — одна.
    expect(screen.getByRole("button", { name: /День/ })).toHaveTextContent(
      "2 страницы",
    );
    expect(screen.getByRole("button", { name: /Неделя/ })).toHaveTextContent(
      "1 страница",
    );
  });

  it("масштаб за потолком недоступен, но цену свою называет", () => {
    show({ start: "2020-01-01", end: "2030-01-01" });

    const day = screen.getByRole("button", { name: /День/ });
    expect(day).toBeDisabled();
    expect(day).toHaveAttribute("title", expect.stringContaining("стр. ленты"));
  });

  it("у плана без дат недоступны окна, отсчитываемые от сегодня", () => {
    show({ dated: false });

    expect(screen.getByRole("button", { name: "Ближайшие 4 недели" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Весь проект" })).toBeEnabled();
  });

  it("сужение периода возвращает дневной масштаб", async () => {
    const user = userEvent.setup();
    show({ start: "2020-01-01", end: "2030-01-01" });

    expect(screen.getByRole("button", { name: /День/ })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Ближайшие 4 недели" }));
    expect(screen.getByRole("button", { name: /День/ })).toBeEnabled();
  });

  it("имя файла видно до нажатия, а не узнаётся после", () => {
    show();
    expect(
      screen.getByTitle("Planora - Переезд офиса - 2026-08-29.pdf"),
    ).toBeInTheDocument();
  });

  it("скачивание уносит выбранный состав, а не всё подряд", async () => {
    const user = userEvent.setup();
    const download = vi.fn<Download>(async () => ({
      blob: new Blob(["x"]),
      filename: "f.pdf",
    }));
    show({}, download);

    await user.click(screen.getByRole("checkbox", { name: /Скоркард/ }));
    await user.click(screen.getByRole("button", { name: "Скачать" }));

    await waitFor(() => expect(download).toHaveBeenCalled());
    const [options] = download.mock.calls[0];
    expect(options.format).toBe("pdf");
    expect(options.sections).toContain("gantt");
    expect(options.sections).not.toContain("scorecard");
  });

  it("отказ сервера доходит до человека словами, а не кодом", async () => {
    const user = userEvent.setup();
    const download = vi.fn<Download>(async () => {
      throw new ApiError("export_scale_too_wide", 422);
    });
    const { onClose } = show({}, download);

    await user.click(screen.getByRole("button", { name: "Скачать" }));

    expect(await screen.findByText(/масштаб/i)).toBeInTheDocument();
    // Окно остаётся открытым: человеку есть что здесь поправить.
    expect(onClose).not.toHaveBeenCalled();
  });
});
