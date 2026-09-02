import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { CSSProperties } from "react";

import { errorKey } from "../api/errors";
import { applyOp, projectQueryKey } from "../api/projects";
import { Field } from "../components/Field";
import { Modal } from "../components/Modal";
import { useLocale } from "../i18n/LocaleProvider";
import { CATEGORY_COLORS, suggestColor } from "../project/categoryColors";

// Палитра и подбор цвета переехали в `project/categoryColors.ts` — у них
// появился второй потребитель (быстрое добавление категории с низа ленты), и
// вторая копия тех же чисел однажды разошлась бы с этой. Реэкспорт оставляет
// прежний путь импорта рабочим — форма как звалась их источником, так им и
// осталась для всех, кто уже на неё ссылается.
export { CATEGORY_COLORS, suggestColor };

export function CategoryForm({
  projectId,
  suggested,
  onClose,
}: {
  projectId: string;
  suggested: string;
  onClose: () => void;
}) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [color, setColor] = useState(suggested);

  const create = useMutation({
    mutationFn: (payload: { name: string; color: string }) =>
      applyOp(projectId, { type: "create_category", name: payload.name, color: payload.color }),
    onSuccess: async () => {
      // Состояние перезапрашивается целиком, а не дописывается руками в кэш.
      // Идентификатор и позицию назначил сервер; сочинить их на клиенте
      // значит завести в кэше строку, которой на сервере нет, — и узнать об
      // этом при первом же действии над ней.
      await queryClient.invalidateQueries({ queryKey: projectQueryKey(projectId) });
      onClose();
    },
  });

  // Название уходит так, как набрано, — только без краевых пробелов. Раньше
  // форма поднимала его в прописные, чтобы заголовок группы в ленте читался
  // единообразно; на деле капс при том же кегле, что у задач, раздувал
  // строку категории и обрезал длинные имена многоточием раньше времени, а
  // единообразие строке даёт начертание (см. .gantt__row--category в
  // gantt.css), а не регистр букв.
  const trimmed = name.trim();

  return (
    <Modal
      title={t("category.new.title")}
      onClose={onClose}
      // Цвет тоже считается введённым: подобранный вручную из десяти кружков,
      // он пропадает от промаха мимо окна так же, как название.
      dirty={name !== "" || color !== suggested}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          create.mutate({ name: trimmed, color });
        }}
      >
        <Field
          id="category-name"
          label={t("category.new.name")}
          value={name}
          onChange={setName}
        />

        {/* Набор переключателей, а не список: выбран ровно один цвет, и
            стрелки клавиатуры обязаны ходить по нему сами — это поведение
            даёт браузер группе радиокнопок с общим `name`. Сам кружок — это и
            есть радиокнопка, перекрашенная в CSS: подменять её собственной
            разметкой значило бы отбирать у браузера и клавиатуру, и читалку. */}
        <fieldset className="fieldset swatches">
          <legend>{t("category.new.color")}</legend>
          <div className="swatches__row">
            {CATEGORY_COLORS.map((option) => (
              <input
                key={option.value}
                type="radio"
                className="swatch"
                name="category-color"
                value={option.value}
                checked={color === option.value}
                onChange={() => setColor(option.value)}
                aria-label={t(`category.new.colors.${option.name}`)}
                style={{ "--swatch": option.value } as CSSProperties}
              />
            ))}
          </div>
        </fieldset>

        {create.error && (
          <p className="error" role="alert">
            {t(errorKey(create.error))}
          </p>
        )}

        <div className="modal__actions">
          <button type="submit" disabled={trimmed === "" || create.isPending}>
            {t("common.create")}
          </button>
          <button type="button" className="button--quiet" onClick={onClose}>
            {t("common.cancel")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
