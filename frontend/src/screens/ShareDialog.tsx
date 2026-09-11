import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";
import { ShareControls } from "../project/ShareControls";

/**
 * A project's public link — as a dialog from the project screen. All the behaviour lives in
 * `ShareControls`: the project's settings show the same body, and these two places have nowhere left to
 * diverge.
 */
export function ShareDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
  const { t } = useLocale();

  return (
    <Modal title={t("share.title")} onClose={onClose}>
      <ShareControls projectId={projectId} onCancel={onClose} />
    </Modal>
  );
}
