import type { ProposalSettingsPatch, ProposalState } from "../api/proposal";
import { SelectField, TextField, ValueField } from "../components/autosave";
import type { useFieldSaves } from "../components/autosave";
import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * The proposal's parameters — the unit, the hours norm, the tax, the currency — in a popover.
 *
 * They are changed once per project, and in the open four fields would compete with the table for the
 * first glance. The button's caption is assembled from the values: a closed popover still says what
 * things are counted in and what the tax is — there is no need to open it for an answer to that
 * question.
 *
 * The fields save themselves, by the same submissions that used to stand in the toolbar: the popover is
 * only a place rather than a different way to edit.
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
              // It never reaches the server: a currency code is exactly three letters, and that can be
              // said by the field without asking anyone.
              if (!/^[A-Z]{3}$/.test(code)) {
                saves.refuse("currency", "proposal.settings.currency_invalid");
                return;
              }
              saves.commit("currency", { currency: code });
            }}
          />
        </div>
        {/* Changing the unit is not a renaming of numbers: that is said before the switch rather than
            after, when all the rates are already different. */}
        <p className="proposal-params__hint">{t("proposal.params.unit_hint")}</p>
      </Menu>
    </span>
  );
}
