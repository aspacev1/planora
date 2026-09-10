import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useLocale } from "../i18n/LocaleProvider";

/**
 * Кнопка, которая перед необратимым действием разворачивает вопрос на своём
 * месте.
 *
 * Окна здесь нет намеренно: окно прерывает работу ради решения, которое человек
 * уже принял, нажав кнопку, и приучает закрывать себя не читая. Подтверждение
 * на месте отвечает на другой вопрос — не «уверены ли вы», а «вот что сейчас
 * сломается», — и стоит ровно там, куда смотрят.
 *
 * Компонент один на все такие кнопки: правил тут три (предупредить словами,
 * дать отказ, не потерять фокус), и каждый экран, изобретающий их заново,
 * ошибается в одном.
 */
export function ConfirmAction({
  label,
  icon,
  warning,
  confirm,
  onConfirm,
  className,
  disabled = false,
}: {
  /** Подпись самой кнопки — до вопроса. */
  label: string;
  /**
   * Знак вместо подписи — для кнопки на строке таблицы, где на слово места
   * нет. Подпись при этом никуда не девается: она становится именем кнопки, и
   * с экрана читается по-прежнему словами, а не «крестик».
   */
  icon?: ReactNode;
  /** Что именно сломается. Не «вы уверены?», а последствие. */
  warning: string;
  /** Подпись подтверждения: она называет действие, а не отвечает «да». */
  confirm: string;
  onConfirm: () => void;
  className?: string;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  const [confirming, setConfirming] = useState(false);
  const group = useRef<HTMLSpanElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  // Была ли выноска только что открыта: фокус возвращается на кнопку только
  // после её сворачивания, а не при первой отрисовке.
  const wasConfirming = useRef(false);

  // Фокус переходит на саму выноску, а не на кнопку подтверждения: человек с
  // клавиатуры нажимает Enter быстрее, чем читает, и подтверждение, поймавшее
  // этот же Enter, не подтверждает ничего — оно возвращает прежнее поведение,
  // добавив к нему лишнее нажатие. На кнопку отказа фокус тоже не ставится:
  // выноска сама называет последствие, и голосом оно читается первым.
  useEffect(() => {
    if (confirming) {
      group.current?.focus();
    } else if (wasConfirming.current) {
      // Выноска свёрнута — а вместе с ней ушёл и узел, на котором стоял
      // фокус. Без возврата человек с клавиатуры оказывался в начале
      // документа и искал место заново после каждого «отмена». Кнопка при
      // этом могла уйти вместе с удалённой строкой — тогда возвращать некуда.
      trigger.current?.focus();
    }
    wasConfirming.current = confirming;
  }, [confirming]);

  if (confirming) {
    return (
      <span className="plan__confirm" role="group" aria-label={warning} tabIndex={-1} ref={group}>
        <span className="muted">{warning}</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            // Вопрос сворачивается сразу: ответ на него уже дан, а результат
            // самого действия покажет экран — ошибкой рядом или исчезновением
            // того, что удалили.
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirm}
        </button>
        <button type="button" className="button--quiet" onClick={() => setConfirming(false)}>
          {t("common.cancel")}
        </button>
      </span>
    );
  }

  return (
    <button
      ref={trigger}
      type="button"
      className={className}
      disabled={disabled}
      aria-label={icon === undefined ? undefined : label}
      title={icon === undefined ? undefined : label}
      onClick={() => setConfirming(true)}
    >
      {icon ?? label}
    </button>
  );
}
