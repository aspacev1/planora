import type { ProposalSettingsPatch, ProposalState } from "../api/proposal";
import type { useFieldSaves } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";
import { ProposalParams } from "./ProposalParams";

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
 * Кнопка — тот же поповер, что стоит в тулбаре таблицы (ProposalParams):
 * второго места с теми же четырьмя полями не заводится.
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
  saves: ReturnType<typeof useFieldSaves<ProposalSettingsPatch>>;
  onNewCategory: () => void;
  onBuild: () => void;
  /** Сборка уже идёт: второй щелчок по карточке ничего не должен запускать. */
  building: boolean;
}) {
  const { t } = useLocale();
  const planEmpty = proposal.plan_facts.tasks === 0;

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
                    tasks: t("proposal.start.tasks", { count: proposal.plan_facts.tasks }),
                    categories: t("proposal.start.categories", {
                      count: proposal.plan_facts.categories,
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
          не вмещает — браузер разорвал бы его на месте панели. Читателю
          кнопка тоже показывается — поля внутри у него выключены, а в чём
          считают смету, знать вправе и он. */}
      <div className="proposal-start__settings">
        <span>{t("proposal.start.settings")}</span>
        <ProposalParams proposal={proposal} canWrite={canWrite} saves={saves} />
      </div>
    </section>
  );
}
