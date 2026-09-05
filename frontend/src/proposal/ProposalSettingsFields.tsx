import type { ProposalSettingsPatch, ProposalState } from "../api/proposal";
import { SelectField, TextField, ValueField } from "../components/autosave";
import type { useFieldSaves } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";

/** Отправки полей настроек сметы — `useFieldSaves` экрана, переданный полям. */
export type SettingsSaves = ReturnType<typeof useFieldSaves<ProposalSettingsPatch>>;

/**
 * Четыре поля параметров сметы: единица оценки, часов в дне, налог, валюта.
 *
 * Один набор на два места — тулбар таблицы и поповер пустого состояния.
 * Поля сохраняют себя сами, как настройки проекта, и правила у них общие:
 * список и число уходят сразу, код валюты — при потере фокуса и только если
 * это три буквы. Два экземпляра этих правил однажды разошлись бы на одном
 * из них.
 *
 * Идентификаторы полей общие: тулбар и поповер на экране никогда не стоят
 * вместе — первый живёт при таблице, второй — пока таблицы нет.
 */
export function ProposalSettingsFields({
  proposal,
  canWrite,
  saves,
}: {
  proposal: Pick<ProposalState, "effort_unit" | "hours_per_day" | "tax_rate_pct" | "currency">;
  canWrite: boolean;
  saves: SettingsSaves;
}) {
  const { t } = useLocale();

  return (
    <>
      <SelectField
        id="proposal-unit"
        label={t("proposal.settings.unit")}
        value={proposal.effort_unit}
        disabled={!canWrite}
        options={[
          { value: "days", label: t("proposal.settings.unit_days") },
          { value: "hours", label: t("proposal.settings.unit_hours") },
        ]}
        save={saves.at("unit")}
        onCommit={(value) => saves.commit("unit", { effort_unit: value as "days" | "hours" })}
      />
      <ValueField
        id="proposal-hours-per-day"
        label={t("proposal.settings.hours_per_day")}
        type="number"
        value={String(proposal.hours_per_day)}
        disabled={!canWrite}
        resetToken={proposal.hours_per_day}
        save={saves.at("hours_per_day")}
        onCommit={(value) =>
          saves.commitNumber("hours_per_day", value, (hoursPerDay) => ({
            hours_per_day: hoursPerDay,
          }))
        }
      />
      <ValueField
        id="proposal-tax"
        label={t("proposal.settings.tax_rate")}
        type="number"
        value={String(proposal.tax_rate_pct)}
        disabled={!canWrite}
        resetToken={proposal.tax_rate_pct}
        save={saves.at("tax")}
        onCommit={(value) =>
          saves.commitNumber("tax", value, (taxRate) => ({ tax_rate_pct: taxRate }))
        }
      />
      <TextField
        id="proposal-currency"
        label={t("proposal.settings.currency")}
        value={proposal.currency}
        disabled={!canWrite}
        resetToken={proposal.currency}
        save={saves.at("currency")}
        onCommit={(value) => {
          const code = value.trim().toUpperCase();
          // До сервера не доходит: код валюты — ровно три буквы, и сказать
          // об этом можно у поля, не спрашивая никого.
          if (!/^[A-Z]{3}$/.test(code)) {
            saves.refuse("currency", "proposal.settings.currency_invalid");
            return;
          }
          saves.commit("currency", { currency: code });
        }}
      />
    </>
  );
}
