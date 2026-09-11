import type { ProposalSettingsPatch, ProposalState } from "../api/proposal";
import type { useFieldSaves } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";
import { ProposalParams } from "./ProposalParams";

/** The quote's three steps — in the order they are gone through. */
const STEPS = ["sections", "estimate", "plan"] as const;

/**
 * An empty quote: what this is and where to begin.
 *
 * Instead of a table without a single row there is one screen: an overline, a heading, a paragraph
 * about the purpose, three steps and two start cards. A newcomer opening the tab for the first time
 * must understand what is done here without leaving for a help page, and take the first step with
 * one button: create a section by hand or assemble the quote from the plan, if a plan already
 * exists.
 *
 * The assembly card is not hidden when the plan is empty but goes dim with an explanation: a
 * vanished card would read as "that does not happen", a dimmed one as "it will, once there are
 * tasks".
 *
 * The quote's parameters are a line under the cards rather than fields: before the first row they
 * are touched rarely, and four fields would compete with the two cards for attention. The button is
 * the same popover that stands in the table's toolbar (ProposalParams): no second place with the
 * same four fields is created.
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
  /** The assembly is already running: a second click on the card must start nothing. */
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
        // A reader is not shown the cards at all: both lead to editing, and dimmed they would invite
        // them to ask for permissions that are not handed out here.
        <p className="muted proposal-start__readonly">{t("proposal.start.readonly")}</p>
      )}

      {/* A div rather than a p: a block-level panel lives inside the popover, and a paragraph does
          not hold blocks — the browser would tear it apart at the panel. A reader is shown the
          button too — the fields inside are disabled for them, while they are entitled to know what
          the quote is counted in. */}
      <div className="proposal-start__settings">
        <span>{t("proposal.start.settings")}</span>
        <ProposalParams proposal={proposal} canWrite={canWrite} saves={saves} />
      </div>
    </section>
  );
}
