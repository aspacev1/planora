import type { ProposalState } from "../api/proposal";
import { Menu } from "../components/Menu";
import { useLocale } from "../i18n/LocaleProvider";
import { ProposalSettingsFields } from "./ProposalSettingsFields";
import type { SettingsSaves } from "./ProposalSettingsFields";

/**
 * Параметры сметы — поповером из строки «Параметры: … · Изменить».
 *
 * Те же четыре поля, что в тулбаре таблицы, и тот же способ сохранения: поле
 * уходит на сервер само и отвечает отметкой у себя. Панель — общее Menu:
 * Esc, щелчок мимо и повторный щелчок по ссылке закрывают её, а выбор внутри
 * — нет. Единицу, налог и валюту правят подряд, и панель, захлопывающаяся
 * после первого поля, открывалась бы четыре раза.
 */
export function ProposalSettingsPopover({
  proposal,
  saves,
}: {
  proposal: ProposalState;
  saves: SettingsSaves;
}) {
  const { t } = useLocale();

  return (
    <Menu label={t("proposal.start.edit")} showCaret={false} buttonClass="proposal-start__edit">
      <div className="proposal-settings-pop">
        <ProposalSettingsFields proposal={proposal} canWrite saves={saves} />
      </div>
    </Menu>
  );
}
