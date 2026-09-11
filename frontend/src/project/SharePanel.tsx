import { useLocale } from "../i18n/LocaleProvider";
import { ShareControls } from "./ShareControls";

/**
 * A project's public link — in the project's settings. The body is the same as in the "Share" dialog on
 * the project screen: one feature, one implementation, otherwise the "Copy" button or the `allowed`
 * check appears in only one of the two places.
 */
export function SharePanel({ projectId }: { projectId: string }) {
  const { t } = useLocale();

  return (
    <section className="settings__fieldset">
      <h2>{t("share.title")}</h2>
      <ShareControls projectId={projectId} />
    </section>
  );
}
