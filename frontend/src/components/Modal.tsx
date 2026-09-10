import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";

import { useLocale } from "../i18n/LocaleProvider";
import { useEscape } from "./useEscape";

/**
 * Что в окне принимает фокус. Тот же список, что у первого поля при открытии:
 * им же замыкается Tab (см. `trapTab`).
 */
const FOCUSABLE =
  'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * Tab не выходит из окна: с последнего поля — на первое, с первого назад — на
 * последнее.
 *
 * `aria-modal` обещает читателю с экрана, что страницы за окном сейчас нет, —
 * и клавиатура обязана держать то же обещание. Без замыкания Tab с кнопки
 * «Создать» уходил в боковую колонку под подложкой, и человек с клавиатуры
 * дальше нажимал ссылки, которых не видел.
 */
function trapTab(event: KeyboardEvent<HTMLElement>, dialog: HTMLElement | null) {
  if (event.key !== "Tab" || dialog === null) return;
  const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (nodes.length === 0) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

type ModalProps = {
  title: string;
  onClose: () => void;
  /**
   * В окне есть введённое, но ещё не сохранённое.
   *
   * Считает потребитель, а не окно: что именно человек успел ввести, знает
   * только форма, и «пустая» форма у каждой своя — где-то это пустое поле, а
   * где-то выбранная не по умолчанию роль.
   */
  dirty?: boolean;
  /**
   * Широкое окно — под содержимое, которое не укладывается в колонку формы.
   *
   * Признак, а не произвольная ширина: окон в приложении немного, и второй
   * размер должен остаться вторым, а не превратиться в поле, которое каждый
   * потребитель настраивает на свой вкус.
   */
  wide?: boolean;
  children: ReactNode;
};

/**
 * Окно, которое ведёт себя как окно.
 *
 * Закрывается по Esc и по клику мимо, ставит фокус на первое поле при
 * открытии и возвращает его туда, откуда его открыли. Всё это — не украшение:
 * без возврата фокуса человек с клавиатуры после закрытия оказывается в
 * начале страницы, а без Esc у него вовсе нет способа уйти, не найдя мышью
 * крестик.
 *
 * Оба этих жеста — короткие и промахиваемые: до кнопки «Отмена» надо
 * дотянуться, а мимо окна попадаешь, промахнувшись по селекту на два десятка
 * пикселей. Пока вводить нечего, цена промаха нулевая, и окно закрывается
 * сразу. Как только в форме появилось введённое (`dirty`), оба жеста сперва
 * спрашивают — иначе форма задачи с её дюжиной полей теряется от одного
 * случайного щелчка. Кнопка «Отмена» самой формы при этом закрывает окно без
 * вопроса: до неё целятся, а по фону промахиваются.
 *
 * Компонент один на всё приложение сознательно: следующий экран, которому
 * понадобится окно, не должен изобретать эти четыре правила заново и
 * ошибиться в одном из них.
 */
export function Modal({ title, onClose, dirty = false, wide = false, children }: ModalProps) {
  const { t } = useLocale();
  const titleId = useId();
  const dialog = useRef<HTMLDivElement>(null);
  // Захватывается при монтировании, а не при закрытии: к моменту закрытия
  // фокус давно внутри окна, и спрашивать его уже поздно.
  const opener = useRef<Element | null>(null);

  const [asking, setAsking] = useState(false);
  // Поле, на котором человека прервал вопрос: туда же его и возвращают, если
  // он ответил «продолжить». Иначе отказ от закрытия стоил бы места в форме.
  const interrupted = useRef<Element | null>(null);
  const keepEditing = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    opener.current = document.activeElement;

    // Первое поле, а не само окно: человек открыл форму, чтобы её заполнить,
    // и лишнее нажатие Tab здесь — это лишний шаг в каждом создании подряд.
    const focusable = dialog.current?.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus();

    return () => {
      const previous = opener.current;
      if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
    };
  }, []);

  /** Промахиваемый жест: без введённого закрывает сразу, с введённым — спрашивает. */
  const close = useCallback(() => {
    if (!dirty) {
      onClose();
      return;
    }
    // Повторный промах, пока вопрос уже задан, ничего не меняет — и не должен
    // переписывать место, куда возвращать фокус: иначе «продолжить» вернуло бы
    // человека на собственную кнопку, а не в поле, где его прервали.
    if (asking) return;
    interrupted.current = document.activeElement;
    setAsking(true);
  }, [asking, dirty, onClose]);

  const dismiss = useCallback(() => {
    setAsking(false);
    const previous = interrupted.current;
    if (previous instanceof HTMLElement && previous.isConnected) previous.focus();
  }, []);

  // Esc через общую стопку слоёв, а не своим слушателем на документе: окно
  // почти всегда всплывает поверх чего-то — карточки задачи, меню, другого
  // окна, — и собственный слушатель у каждого закрывал бы одним нажатием всех
  // сразу. Слушатель всё так же на документе, а не на самом окне: Esc обязан
  // работать и тогда, когда фокус ушёл из окна, — иначе правило действует не
  // всегда, а это хуже, чем не действовать вовсе.
  //
  // Esc поверх самого вопроса означает «продолжить», а не «закрыть»: клавиша
  // отменяет последнее действие, а не доводит его до конца. Иначе два Esc
  // подряд — привычный жест «закрыть всё» — вели бы ровно к той потере, ради
  // которой вопрос и задан. Слой при этом один: вопрос живёт внутри окна, и
  // отдавать ему собственное место в стопке значило бы требовать третьего Esc
  // там, где человек ждёт двух.
  useEscape(() => {
    if (asking) {
      dismiss();
      return;
    }
    close();
  });

  // Фокус переезжает на «продолжить»: вопрос задан клавишей, и отвечать на
  // него человек будет тоже клавишей. Первой под рукой стоит безопасная.
  useEffect(() => {
    if (asking) keepEditing.current?.focus();
  }, [asking]);

  return (
    <div
      className="modal__backdrop"
      data-testid="modal-backdrop"
      // Клик именно по подложке, а не по всплывшему из окна: иначе окно
      // закрывалось бы от клика по любому своему полю.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        className={`modal${wide ? " modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={dialog}
        onKeyDown={(event) => trapTab(event, dialog.current)}
      >
        <h2 className="modal__title" id={titleId}>
          {title}
        </h2>
        {children}

        {/* Вопрос внутри того же окна, а не вторым окном поверх первого: окна
            поверх окон закрываются в два приёма и путают, какое из них Esc
            имеет в виду. */}
        {asking && (
          <div className="modal__confirm" role="alert">
            <p>{t("modal.discard.question")}</p>
            <div className="modal__actions">
              <button type="button" ref={keepEditing} onClick={dismiss}>
                {t("modal.discard.keep")}
              </button>
              <button type="button" className="button--quiet" onClick={onClose}>
                {t("modal.discard.close")}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
