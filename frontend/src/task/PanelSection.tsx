import type { ReactNode } from "react";

/**
 * Аккордеон карточки: заголовок-створка и содержимое под ней.
 *
 * Нативный `details`: створка доступна с клавиатуры и читается вслух без
 * единой строки скрипта. Раскрыт с порога — аккордеон здесь способ свернуть
 * прочитанное, а не спрятать поля по умолчанию.
 *
 * Общий для карточки задачи и карточки строки сметы: две створки с разной
 * разметкой разошлись бы на первой правке каретика.
 */
export function PanelSection({
  title,
  icon,
  note,
  children,
}: {
  title: string;
  /** Значок перед заголовком — например, замок у раздела «только для команды». */
  icon?: ReactNode;
  /** Пояснение мелким шрифтом после заголовка: кому видно содержимое. */
  note?: string;
  children: ReactNode;
}) {
  return (
    <details className="panel__section" open>
      <summary className="panel__section-head">
        {icon}
        {title}
        {note !== undefined && <span className="panel__section-note">{note}</span>}
      </summary>
      {children}
    </details>
  );
}
