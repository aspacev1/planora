import type { ProposalSettingsPatch, ProposalState } from "../api/proposal";
import { SelectField, TextField, ValueField } from "../components/autosave";
import type { useFieldSaves } from "../components/autosave";
import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Параметры предложения — единица, норма часов, налог, валюта — в поповере.
 *
 * Их меняют раз в проект, а на виду четыре поля спорили бы с таблицей за
 * первый взгляд. Подпись кнопки складывается из значений: закрытый поповер
 * всё равно говорит, в чём считают и какой налог, — открывать его ради
 * ответа на этот вопрос не нужно.
 *
 * Поля сохраняют себя сами, теми же отправками, что и раньше стояли в
 * тулбаре: поповер — только место, не другой способ править.
 */
export function ProposalParams({
  proposal,
  canWrite,
  saves,
}: {
  proposal: ProposalState;
  canWrite: boolean;
  saves: ReturnType<typeof useFieldSaves<ProposalSettingsPatch>>;
}) {
  const { t } = useLocale();

  const unitLabel = t(
    proposal.effort_unit === "hours" ? "proposal.settings.unit_hours" : "proposal.settings.unit_days",
  );
  const summary = t("proposal.params.summary", {
    unit: unitLabel,
    tax: proposal.tax_rate_pct,
    currency: proposal.currency,
  });

  return (
    <span className="proposal-params">
      <Menu label={summary} buttonLabel={t("proposal.params.open")}>
        <div className="proposal-params__grid">
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
            onCommit={(value) =>
              saves.commit("unit", { effort_unit: value as "days" | "hours" })
            }
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
              // До сервера не доходит: код валюты — ровно три буквы, и
              // сказать об этом можно у поля, не спрашивая никого.
              if (!/^[A-Z]{3}$/.test(code)) {
                saves.refuse("currency", "proposal.settings.currency_invalid");
                return;
              }
              saves.commit("currency", { currency: code });
            }}
          />
        </div>
        {/* Смена единицы — не переименование чисел: об этом говорится до
            того, как переключили, а не после, когда все ставки уже другие. */}
        <p className="proposal-params__hint">{t("proposal.params.unit_hint")}</p>
      </Menu>
    </span>
  );
}
