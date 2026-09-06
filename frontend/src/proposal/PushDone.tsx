import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { errorKey } from "../api/errors";
import { projectQueryKey, undoBatch } from "../api/projects";
import { useDismissToast, useToast } from "../components/toast";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Действия в тосте после переноса: посмотреть, что получилось, или вернуть
 * всё назад.
 *
 * «Вернуть» снимает ту самую пачку, номер которой сервер назвал в ответе на
 * перенос, — а не «последнее изменение»: пока тост висит, сосед по проекту
 * успевает применить своё, и безадресная отмена сняла бы чужую правку. Ссылки
 * строк на задачи при этом обнуляет база, и строки снова переносимы.
 */
export function PushDone({ projectId, batchId }: { projectId: string; batchId: string }) {
  const { t } = useLocale();
  const dismiss = useDismissToast();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const undo = () => {
    // Сначала спрятать, потом действовать: результат покажет сама таблица, а
    // висящий тост предлагал бы вернуть уже возвращённое.
    dismiss();
    undoBatch(projectId, batchId).then(
      () => queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) }),
      (refusal: unknown) => toast({ message: t(errorKey(refusal)), tone: "error" }),
    );
  };

  return (
    <>
      <button
        type="button"
        className="toast__action"
        onClick={() => {
          dismiss();
          navigate(`/projects/${projectId}`);
        }}
      >
        {t("proposal.push.open_gantt")}
      </button>
      <button type="button" className="toast__action" onClick={undo}>
        {t("undo.action")}
      </button>
    </>
  );
}
