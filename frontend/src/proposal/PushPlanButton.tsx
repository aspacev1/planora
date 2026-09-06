import type { ProposalStage } from "../api/proposal";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Кнопка переноса в план — одна на оба места, где она стоит: полоса этапов
 * и блок «Дальше» карточки итогов.
 *
 * Перенос доступен с любого этапа, черновика в том числе: не все отправляют
 * документ клиенту, и смета, написанная для себя, идёт в план сразу. Но вес
 * у кнопки разный. Пока предложение не согласовано, она тихая: следующий
 * шаг сделки — отправить и дождаться ответа, и залитая кнопка рядом звала бы
 * перенести то, что клиент ещё может переписать. После согласования перенос
 * — единственное, что осталось сделать, и кнопка становится главной.
 *
 * Многоточие в подписи — знак, что за нажатием следует окно, а не сам
 * перенос: там выбирают строки и видят, куда что ляжет. Оно остаётся и у
 * главной кнопки — окно открывается то же самое.
 *
 * Подпись меняется по ходу дела: пока в плане ничего нет — перенести;
 * перенесли часть — перенести только новое, счётом. Кнопка, зовущая
 * переносить уже перенесённое, вернула бы прежние дубли на словах.
 */
export function PushPlanButton({
  status,
  pushedCount,
  pushableCount,
  className,
  onPush,
}: {
  status: ProposalStage;
  /** Сколько строк уже в плане и сколько оценённых ещё можно перенести. */
  pushedCount: number;
  pushableCount: number;
  className?: string;
  /** Открыть окно переноса. */
  onPush: () => void;
}) {
  const { t } = useLocale();

  const weight = status === "agreed" ? "button--primary" : "button--quiet";
  const label =
    pushedCount > 0 ? t("proposal.push.more", { count: pushableCount }) : t("proposal.push.action");

  return (
    <button
      type="button"
      className={className === undefined ? weight : `${weight} ${className}`}
      // Переносить нечего — без единой оценённой строки окно показало бы
      // пустой список с выключенной кнопкой.
      disabled={pushableCount === 0}
      onClick={onPush}
    >
      {label}
    </button>
  );
}
