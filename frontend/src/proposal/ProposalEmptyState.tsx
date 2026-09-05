import type { ProposalState } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";
import { formatAmount } from "./money";
import type { SettingsSaves } from "./ProposalSettingsFields";
import { ProposalSettingsPopover } from "./ProposalSettingsPopover";

/** Три шага сметы — в том порядке, в каком их проходят. */
const STEPS = ["sections", "estimate", "plan"] as const;

/**
 * Пустая смета: что это и с чего начать.
 *
 * Вместо таблицы без единой строки — один экран: надзаголовок, заголовок,
 * абзац о назначении, три шага и две карточки старта. Новичок, открывший
 * вкладку впервые, должен понять, что здесь делают, не уходя за подсказкой,
 * и сделать первый шаг одной кнопкой: завести раздел руками или собрать
 * смету из плана, если план уже есть.
 *
 * Карточка сборки при пустом плане не прячется, а гаснет с объяснением:
 * пропавшая карточка читалась бы как «такого не бывает», погасшая — как
 * «будет, когда появятся задачи».
 *
 * Параметры сметы — строкой под карточками, а не полями: до первой строки их
 * трогают редко, и четыре поля спорили бы с двумя карточками за внимание.
 * «Изменить» открывает те же поля поповером.
 */
export function ProposalEmptyState({
  proposal,
  canWrite,
  saves,
  onNewCategory,
  onBuild,
  building,
}: {
  proposal: ProposalState;
  canWrite: boolean;
  saves: SettingsSaves;
  onNewCategory: () => void;
  onBuild: () => void;
  /** Сборка уже идёт: второй щелчок по карточке ничего не должен запускать. */
  building: boolean;
}) {
  const { t, locale } = useLocale();
  const planEmpty = proposal.plan.tasks === 0;

  const settings = t("proposal.start.settings", {
    unit: t(
      proposal.effort_unit === "hours" ? "proposal.start.unit_hours" : "proposal.start.unit_days",
    ),
    hours: proposal.hours_per_day,
    tax: formatAmount(locale, proposal.tax_rate_pct),
    currency: proposal.currency,
  });

  return (
    <section className="proposal-start" aria-labelledby="proposal-start-title">
      <p className="proposal-start__eyebrow">{t("proposal.start.eyebrow")}</p>
      <h2 id="proposal-start-title" className="proposal-start__title">
        {t("proposal.start.title")}
      </h2>
      <p className="proposal-start__lead">{t("proposal.start.lead")}</p>

      <ol className="proposal-start__steps">
        {STEPS.map((step) => (
          <li key={step} className="proposal-start__step">
            <strong>{t(`proposal.start.steps.${step}.title`)}</strong>
            {t(`proposal.start.steps.${step}.hint`)}
          </li>
        ))}
      </ol>

      {canWrite ? (
        <div className="proposal-start__options">
          <button type="button" className="proposal-start__card" onClick={onNewCategory}>
            <span className="proposal-start__card-title">{t("proposal.start.manual.title")}</span>
            <span className="proposal-start__card-hint">{t("proposal.start.manual.hint")}</span>
          </button>
          <button
            type="button"
            className="proposal-start__card"
            disabled={planEmpty || building}
            onClick={onBuild}
          >
            <span className="proposal-start__card-title">{t("proposal.start.build.title")}</span>
            <span className="proposal-start__card-hint">
              {planEmpty
                ? t("proposal.start.build.empty")
                : t("proposal.start.build.hint", {
                    tasks: t("proposal.start.tasks", { count: proposal.plan.tasks }),
                    categories: t("proposal.start.categories", {
                      count: proposal.plan.categories,
                    }),
                  })}
            </span>
          </button>
        </div>
      ) : (
        // Читателю карточки не показываются вовсе: обе ведут к правке, и
        // погасшие они звали бы просить права, которых здесь не выдают.
        <p className="muted proposal-start__readonly">{t("proposal.start.readonly")}</p>
      )}

      {/* div, а не p: внутри поповера живёт блочная панель, а абзац блоков
          не вмещает — браузер разорвал бы его на месте панели. */}
      <div className="proposal-start__settings">
        <span>{settings}</span>
        {canWrite && (
          <>
            <span aria-hidden="true">·</span>
            <ProposalSettingsPopover proposal={proposal} saves={saves} />
          </>
        )}
      </div>
    </section>
  );
}
