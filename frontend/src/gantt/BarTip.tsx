import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { CSSProperties, FocusEvent, PointerEvent, ReactNode } from "react";

import type { Task } from "../api/projects";
import { modKeyLabel } from "../components/hotkeys";
import { formatShortDate } from "../i18n/dates";
import { useLocale } from "../i18n/LocaleProvider";

/**
 * Карточка, которая показывает под курсором то, чего на полоске не написано.
 *
 * Полоска умещает название и проценты, а остальное — статус, даты, исполнителей
 * — человек узнаёт, только открыв карточку задачи. Наведение отвечает на те же
 * вопросы, не уводя с ленты и ничего не открывая.
 *
 * Узел один на всю ленту, а не по одному на полоску: на сотне задач это сотня
 * скрытых узлов ни за чем. Отсюда и контекст — иначе через строку пришлось бы
 * протаскивать пять новых пропсов, ни один из которых строке не нужен.
 */

/** Точка, от которой карточка отсчитывает своё место: курсор или край полоски. */
type Anchor = { x: number; y: number };

type BarTipApi = {
  /**
   * Навести. Карточка не появляется сразу: `immediate` нужен там, где ждать
   * нечего, — при переходе фокуса с клавиатуры.
   *
   * `keys` — показывать ли строку сочетаний: она про то, чего гость не может.
   */
  show: (task: Task, anchor: Anchor, keys: boolean, immediate?: boolean) => void;
  /** Двигать за курсором — но только ту карточку, которая уже назначена. */
  track: (anchor: Anchor) => void;
  hide: () => void;
  /** Нажатие: карточка гаснет и запирается до конца жеста. */
  press: () => void;
  /** Отпускание: замок снимается, но карточка сама не возвращается. */
  release: () => void;
};

/**
 * Назначенная карточка. `shown` отделяет назначенную от показанной: пока
 * выдержка не вышла, задача и точка уже известны, а на экране ничего нет.
 */
type Pending = { task: Task; anchor: Anchor; keys: boolean; shown: boolean };

const BarTipContext = createContext<BarTipApi | null>(null);

/** Отступ карточки от курсора — как в макете. */
export const GAP = 14;
/** Ширина карточки. Та же величина стоит в стилях: шире имени она не станет. */
const TIP_WIDTH = 235;
/**
 * Высота до первого измерения — на один кадр разметки, не больше.
 *
 * Настоящая высота у каждой карточки своя: имя задачи переносится на вторую
 * строку, и по этому числу карточка с длинным именем у нижнего края экрана не
 * переворачивалась бы, а обрезалась. Живой узел меряется сразу после
 * отрисовки (см. `BarTip`), а запас здесь взят с избытком: ошибка в большую
 * сторону лишь раньше переворачивает карточку, в меньшую — оставила бы её за
 * обрезом.
 */
const TIP_HEIGHT = 96;
/**
 * Сколько курсор стоит на полоске, прежде чем появится карточка.
 *
 * Без выдержки проведённый поперёк ленты курсор высекает по вспышке на каждой
 * полоске: карточка успевает показаться и погаснуть там, где её никто не
 * звал. Столько же держат наведение системные подсказки — меньше читается как
 * дребезг, больше как задумчивость.
 */
export const SHOW_DELAY = 300;

/**
 * Карточка не выходит за край экрана: у края она переворачивается на другую
 * сторону, а если и перевёрнутой не помещается — прижимается к краю.
 */
function placeTip({ x, y }: Anchor, height: number): CSSProperties {
  const left = x + GAP + TIP_WIDTH > window.innerWidth ? x - GAP - TIP_WIDTH : x + GAP;
  const top = y + GAP + height > window.innerHeight ? y - GAP - height : y + GAP;
  // Нижняя граница считается по измеренной высоте, поэтому карточка выше
  // окна прижимается к верхнему краю, а не уезжает за него: `Math.max`
  // стоит снаружи и в споре двух прижатий побеждает верхнее.
  return {
    left: Math.max(GAP, left),
    top: Math.max(GAP, Math.min(top, window.innerHeight - height - GAP)),
  };
}

export function BarTipProvider({
  names,
  formatDay,
  children,
}: {
  /**
   * Имена исполнителей по идентификаторам. Приходят пропсом сверху и никогда
   * не спрашиваются отсюда: лента не должна решать, у кого что спрашивать, —
   * на публичной странице состав организации не отдаётся вовсе.
   */
  names?: ReadonlyMap<string, string>;
  /**
   * Подпись дня вместо короткой даты — для относительного представления:
   * карточка обязана говорить на языке шкалы за её спиной, «День 8», а не
   * настоящей датой, которой у плана нет.
   */
  formatDay?: (iso: string) => string;
  children: ReactNode;
}) {
  const [tip, setTip] = useState<Pending | null>(null);
  // Идёт ли жест. В ref, а не в состоянии: значение читается в обработчиках
  // указателя и на отрисовку не влияет.
  const pressed = useRef(false);
  // Отложенный показ. Тоже ref: отсчёт идёт мимо отрисовки, а отменять его
  // приходится из каждого второго обработчика.
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const api = useMemo<BarTipApi>(() => {
    const forget = () => {
      clearTimeout(timer.current);
      timer.current = undefined;
    };
    return {
      show: (task, anchor, keys, immediate = false) => {
        if (pressed.current) return;
        forget();
        setTip({ task, anchor, keys, shown: immediate });
        if (immediate) return;
        timer.current = setTimeout(() => {
          timer.current = undefined;
          setTip((current) => (current === null ? null : { ...current, shown: true }));
        }, SHOW_DELAY);
      },
      // Наведение показывает, движение только переставляет: иначе карточка
      // возвращалась бы прямо под пальцем сразу после перетаскивания — а
      // человек к этому моменту уже целится в соседний день. Пока идёт
      // выдержка, движение переставляет будущее место карточки: за это время
      // курсор уходит с той точки, на которой вошёл на полоску.
      track: (anchor) => setTip((current) => (current === null ? null : { ...current, anchor })),
      hide: () => {
        forget();
        setTip(null);
      },
      press: () => {
        pressed.current = true;
        forget();
        setTip(null);
      },
      release: () => {
        pressed.current = false;
      },
    };
  }, []);

  // Отсчёт не должен пережить ленту: сработавший после размонтирования таймер
  // ставит состояние отсутствующему узлу.
  useEffect(() => () => clearTimeout(timer.current), []);

  /**
   * Прокрутка уводит полоску из-под карточки.
   *
   * Карточка стоит по координатам окна и сама за лентой не едет — оставшись
   * висеть, она приписывала бы работу одной задачи другой, оказавшейся под
   * ней. Слушаем на перехвате: событие прокрутки не всплывает, а прокручиваются
   * здесь и лента, и страница под ней.
   */
  const armed = tip !== null;
  useEffect(() => {
    if (!armed) return;
    const dismiss = () => api.hide();
    window.addEventListener("scroll", dismiss, { capture: true, passive: true });
    return () => window.removeEventListener("scroll", dismiss, { capture: true });
  }, [api, armed]);

  return (
    <BarTipContext.Provider value={api}>
      {children}
      {tip !== null && tip.shown && (
        <BarTip task={tip.task} anchor={tip.anchor} keys={tip.keys} names={names} formatDay={formatDay} />
      )}
    </BarTipContext.Provider>
  );
}

/**
 * Обработчики полоски.
 *
 * Возвращаются готовым набором, а не по одному: полоска и без того несёт на
 * себе перетаскивание, и разбирать, какое событие чьё, в разметке не надо.
 * Вне провайдера все они молчат — диаграмма рисуется и там, где карточки нет.
 *
 * `keys` — право двигать полоску: строка сочетаний показывается только тому,
 * кому есть что ими сделать. Читателю и гостю она обещала бы работу, которую
 * сервер отклонит.
 */
export function useBarTip(task: Task, keys = false) {
  const api = useContext(BarTipContext);
  const cursor = useCallback(
    (event: PointerEvent<HTMLElement>): Anchor => ({ x: event.clientX, y: event.clientY }),
    [],
  );

  return useMemo(
    () => ({
      onPointerEnter: (event: PointerEvent<HTMLElement>) => api?.show(task, cursor(event), keys),
      onPointerMove: (event: PointerEvent<HTMLElement>) => api?.track(cursor(event)),
      onPointerLeave: () => api?.hide(),
      onPointerDown: () => api?.press(),
      onPointerUp: () => api?.release(),
      onPointerCancel: () => api?.release(),
      // С клавиатуры курсора нет, и карточка встаёт у самой полоски: место под
      // курсором означало бы точку, которой на экране никто не видит. И без
      // выдержки: ждать её незачем там, где полоску выбрали, а не задели по
      // дороге к соседней.
      onFocus: (event: FocusEvent<HTMLElement>) => {
        const box = event.currentTarget.getBoundingClientRect();
        api?.show(task, { x: box.left, y: box.bottom }, keys, true);
      },
      onBlur: () => api?.hide(),
    }),
    [api, cursor, keys, task],
  );
}

/**
 * Сама карточка.
 *
 * Скрыта от чтения с экрана: всё, что в ней написано, полоска уже называет
 * своим `aria-label`, и второй голос об одном и том же только удлиняет
 * прочтение ленты.
 */
function BarTip({
  task,
  anchor,
  keys,
  names,
  formatDay,
}: {
  task: Task;
  anchor: Anchor;
  keys: boolean;
  names?: ReadonlyMap<string, string>;
  formatDay?: (iso: string) => string;
}) {
  const { t } = useLocale();
  const node = useRef<HTMLDivElement>(null);
  const [height, setHeight] = useState(TIP_HEIGHT);

  /**
   * Настоящая высота карточки — по живому узлу.
   *
   * Меряем в разметочном эффекте: он идёт после отрисовки, но до кадра, и
   * перевёрнутой у нижнего края карточка появляется сразу, а не переставляет
   * себя у человека на глазах. В зависимостях написанное, а не точка под
   * курсором: ширина карточки постоянна, высота меняется только от текста, а
   * мерить её заново на каждом движении курсора значило бы столько же раз
   * пересчитывать разметку страницы. Нулевую высоту не берём: столько узел
   * показывает, пока разметки нет вовсе, — тогда честнее запас.
   *
   * Строка сочетаний в зависимостях по той же причине, что и текст: она
   * прибавляет карточке две строки, и без пересчёта карточка у нижнего края
   * экрана перекрывала бы ими собственную полоску.
   */
  useLayoutEffect(() => {
    const measured = node.current?.offsetHeight ?? 0;
    if (measured > 0) setHeight(measured);
  }, [task, names, keys, t]);

  // Короткая форма даты, а не полная: карточка шириной 235px, и «12 августа —
  // 14 августа» в её правой колонке переносится на вторую строку.
  const day = formatDay ?? ((iso: string) => formatShortDate(t, iso));
  const dates = `${day(task.start_date)} → ${day(task.end_date)}`;
  const status =
    task.status === "blocked"
      ? `⚠ ${t(`task.status.${task.status}`)}`
      : t(`task.status.${task.status}`);
  const people = assigneeText(task, t, names);

  return (
    <div
      ref={node}
      className="gantt__tip"
      style={placeTip(anchor, height)}
      data-testid="bar-tip"
      aria-hidden="true"
    >
      {/* Название — содержимое пользователя: не переводится. */}
      <strong className="gantt__tip-name">{task.name}</strong>
      <div className="gantt__tip-grid">
        <span>{status}</span>
        <b>{dates}</b>
        {people !== null && <span>{people}</span>}
        {/* Без исполнителей процент остаётся в своей колонке: сдвинутый влево,
            он читался бы приглушённой подписью к пустоте. */}
        <b className={people === null ? "gantt__tip-alone" : undefined}>{task.progress_pct}%</b>
      </div>
      {/* Флаг риска — слово исполнителя, и подсказка повторяет его дословно:
          «есть риск — жду доступ» отвечает на вопрос, ради которого на
          полоску навели. У «сделано» флаг уже история. */}
      {task.status !== "done" && task.risk !== "green" && (
        <div className="gantt__tip-risk" data-risk={task.risk}>
          <b>{t("gantt.tip.risk", { risk: t(`task.risk.${task.risk}`) })}</b>
          {task.risk_note && ` — ${task.risk_note}`}
        </div>
      )}
      {/* Сочетания клавиш — здесь, а не в отдельной справке: карточка и так
          висит над той самой полоской, к которой они относятся, и это
          единственное место, где человек читает про задачу, ничего не открыв.
          Скрыта от чтения с экрана вместе со всей карточкой — тому, кто читает
          с экрана, о том же говорит `aria-keyshortcuts` полоски. */}
      {keys && <div className="gantt__tip-keys">{t("gantt.tip.keys", { mod: modKeyLabel() })}</div>}
    </div>
  );
}

/**
 * Строка исполнителей: одного зовут по имени, нескольких — «первый и ещё N».
 *
 * Перечисления карточка такой ширины не выдержит, а «и ещё 2» отвечает на
 * вопрос «одна ли это работа» не хуже трёх имён. Имён нет вовсе — строки нет:
 * пустое место честнее прочерка, который читался бы как «никто не назначен»
 * там, где состав просто не спрашивали.
 */
function assigneeText(
  task: Task,
  t: (key: string, params?: Record<string, string | number>) => string,
  names?: ReadonlyMap<string, string>,
): string | null {
  if (names === undefined) return null;
  const known = task.assignee_ids
    .map((id) => names.get(id))
    .filter((name): name is string => name !== undefined);
  if (known.length === 0) return null;
  if (known.length === 1) return known[0];
  return t("gantt.tip.more", { name: known[0], count: known.length - 1 });
}
