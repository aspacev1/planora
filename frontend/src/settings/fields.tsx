import { useEffect, useMemo, useState } from "react";

import type { SlugCheck } from "../api/org";
import { SaveMark } from "../components/autosave";
import type { FieldSave } from "../components/autosave";
import { useLocale } from "../i18n/LocaleProvider";
import { browserTimeZone, timeZoneNames } from "../time/zone";

/**
 * Поля, которые нужны обоим экранам настроек.
 *
 * Организация и проект настраивают одни и те же величины — рабочие дни,
 * календарь дат, слаг, — и написанные в двух экранах порознь они разъедутся
 * на первой правке: один экран научится понимать пустую строку, другой нет.
 */

/**
 * Маска рабочих дней недели.
 *
 * Нумерация — как на сервере: бит 0 это понедельник. Переводить её в другую
 * нумерацию по дороге значило бы завести второе представление одного и того
 * же, и разъехались бы они на первом же проекте с рабочей субботой.
 */
export function WorkingDaysField({
  value,
  onChange,
  disabled,
  save,
}: {
  value: number;
  onChange: (mask: number) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  const [emptied, setEmptied] = useState(false);

  // Неделя без рабочих дней — не настройка, а невозможное состояние: сервер
  // такую маску не примет, и снятая последняя галочка возвращалась бы обратно
  // с ответом «проверьте форму», где ни одно поле не названо. Отказ объясняется
  // здесь же — так же, как список дат объясняет непонятую дату, не отправляя её.
  const toggle = (day: number, on: boolean) => {
    const mask = on ? value & ~(1 << day) : value | (1 << day);
    if (mask === 0) {
      setEmptied(true);
      return;
    }
    setEmptied(false);
    onChange(mask);
  };

  return (
    <fieldset className="settings__fieldset">
      {/* Отметка стоит под днями, а не в подписи: подпись — имя всей группы,
          и «Сохранено», попавшее в него, читалка прочтёт как часть названия. */}
      <legend>{t("settings.working_days")}</legend>
      <div className="settings__days">
        {[0, 1, 2, 3, 4, 5, 6].map((day) => {
          // Подписи дней недели живут в словарях под номерами `getUTCDay`, где
          // нулевое — воскресенье. Здесь нумерация серверная, поэтому перевод
          // нужен ровно один и ровно здесь.
          const label = t(`calendar.weekday.${(day + 1) % 7}`);
          const on = (value & (1 << day)) !== 0;
          return (
            <label key={day} className="settings__day">
              <input
                type="checkbox"
                checked={on}
                disabled={disabled}
                onChange={() => toggle(day, on)}
              />
              {label}
            </label>
          );
        })}
      </div>
      <SaveMark save={save} />
      {emptied && (
        <span className="error" role="alert">
          {t("settings.working_days_empty")}
        </span>
      )}
    </fieldset>
  );
}

/**
 * Часовой пояс — выбором из списка, а не строкой.
 *
 * Имя из базы IANA («Europe/Moscow») набрать по памяти без опечатки трудно, а
 * ошибка в нём не видна: сервер откажет, и человек останется гадать, чем
 * «Europe/Moskva» хуже. Список даёт сам браузер — своя копия базы поясов
 * состарилась бы вместе с приложением.
 *
 * Пустое значение — не «пусто», а отдельный осмысленный выбор: считать сутки
 * по часам браузера. Он стоит первым и выбран по умолчанию, потому что почти
 * всегда прав; руками пояс задают те, у кого браузер врёт, — уехавшие и
 * сидящие через VPN.
 */
export function TimeZoneField({
  id,
  label,
  hint,
  autoLabel,
  value,
  onChange,
  disabled,
  save,
}: {
  id: string;
  label: string;
  hint?: string;
  /** Подпись выбора «по браузеру» — с поясом, который браузер сообщает. */
  autoLabel: string;
  /** `null` — пояс не выбран, сутки считаются по браузеру. */
  value: string | null;
  onChange: (zone: string | null) => void;
  disabled?: boolean;
  /** Отметка отправки рядом с полем — как у остальных полей настроек. */
  save?: FieldSave;
}) {
  // Сохранённый выбор и пояс машины добавляются к списку принудительно:
  // браузер старее базы IANA не знает про недавно заведённый пояс, и без
  // этого поле показало бы не то, что записано в профиле.
  const zones = useMemo(() => timeZoneNames(value, browserTimeZone()), [value]);

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="muted">{hint}</span>}
      <select
        id={id}
        name={id}
        value={value ?? ""}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value === "" ? null : event.target.value)}
      >
        <option value="">{autoLabel}</option>
        {zones.map((zone) => (
          <option key={zone} value={zone}>
            {zone}
          </option>
        ))}
      </select>
      <SaveMark save={save} />
    </p>
  );
}

/** Строки в списке дат: пустые отбрасываются, порядок и повторы — забота сервера. */
export function parseDates(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((item) => item.trim())
    .filter((item) => item !== "");
}

/**
 * Порог сдвига из поля ввода: `null` — «числа здесь нет, отправлять нечего».
 *
 * Пустое поле не значит «ноль»: нулевой порог велит объяснять каждый сдвиг, и
 * человек, стёрший число перед тем как набрать новое, такого не просил. А
 * `Number` сам по себе именно это и делает — пустую строку превращает в ноль, а
 * мусор в `NaN`, — поэтому обе проверки стоят здесь, общие для обоих экранов, а
 * не написаны на каждом порознь.
 */
export function parseThresholdDays(text: string): number | null {
  const value = text.trim();
  if (value === "") return null;
  const days = Number(value);
  // Отрицательный порог — то же самое, что `min={0}` у поля: дней «минус пять»
  // не бывает, и сервер откажет; отказ, которого можно не показывать, лучше не
  // показывать.
  if (!Number.isFinite(days) || days < 0) return null;
  return days;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Список дат — праздники и рабочие субботы.
 *
 * Многострочное поле, а не набор датапикеров: праздники вбивают списком раз в
 * год, и десять полей с календариками для этого хуже, чем одно, куда список
 * вставляется целиком.
 */
export function DateListField({
  id,
  label,
  hint,
  value,
  onCommit,
  disabled,
  save,
}: {
  id: string;
  label: string;
  hint?: string;
  value: string[];
  onCommit: (dates: string[]) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  // Список сравнивается содержимым, а не ссылкой: состояние проекта и
  // организации переписывается целиком ответом на любую правку, и массив дат
  // приходит новым объектом с теми же датами после сохранения любого соседнего
  // поля. Сверяй мы ссылку, дедлайн, сохранённый секунду назад, стирал бы
  // набираемые тут праздники.
  const joined = value.join("\n");
  const [text, setText] = useState(joined);
  const [typing, setTyping] = useState(false);

  // Сервер нормализует список — сортирует и убирает повторы, — и поле обязано
  // показать то, что он вернул, а не то, что человек набрал. Отсортированный
  // список нередко равен присланному, поэтому одного `value` для этого мало:
  // возврат к правде запускает и завершённая отправка.
  useEffect(() => {
    setText(joined);
    setTyping(false);
  }, [joined, save?.settled]);

  const broken = parseDates(text).filter((item) => !ISO_DATE.test(item));

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      {hint && <span className="muted">{hint}</span>}
      <textarea
        id={id}
        name={id}
        rows={4}
        value={text}
        disabled={disabled}
        onChange={(event) => {
          setText(event.target.value);
          setTyping(true);
        }}
        onBlur={() => {
          setTyping(false);
          if (broken.length > 0) return;
          const dates = parseDates(text);
          // Порядок в списке ничего не значит: это множество дат.
          if (dates.join(",") !== [...value].join(",")) onCommit(dates);
        }}
      />
      {broken.length > 0 ? (
        <span className="error" role="alert">
          {t("settings.bad_dates", { dates: broken.join(", ") })}
        </span>
      ) : (
        <SaveMark save={typing ? undefined : save} />
      )}
    </p>
  );
}

/**
 * Поле слага с подсказкой свободного варианта.
 *
 * Занятость спрашивается у сервера по мере ввода, а не при отправке: раздел 12
 * обещает свободный вариант «прямо в поле ввода до отправки формы». Проверка
 * откладывается на полсекунды после последнего нажатия — иначе запрос уходит
 * на каждую букву и отвечает про недописанное слово.
 */
export function SlugField({
  id,
  label,
  value,
  check,
  onCommit,
  disabled,
  save,
}: {
  id: string;
  label: string;
  value: string;
  check: (slug: string) => Promise<SlugCheck>;
  onCommit: (slug: string) => void;
  disabled?: boolean;
  save?: FieldSave;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState(value);
  const [status, setStatus] = useState<SlugCheck | null>(null);
  const [typing, setTyping] = useState(false);

  // Сервер приводит слаг к своей форме — «Редизайн 2026» возвращается как
  // `redizayn-2026`, — и поле обязано показать то, что он вернул.
  useEffect(() => {
    setDraft(value);
    setTyping(false);
  }, [value, save?.settled]);

  useEffect(() => {
    const candidate = draft.trim();
    if (candidate === "" || candidate === value) {
      setStatus(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      check(candidate)
        .then((result) => {
          // Ответ на устаревший запрос игнорируется: человек успел дописать
          // ещё букву, и подсказка про предыдущее слово только запутает.
          if (alive) setStatus(result);
        })
        .catch(() => {
          if (alive) setStatus(null);
        });
    }, 400);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [draft, value, check]);

  const commit = (slug: string) => {
    setDraft(slug);
    setTyping(false);
    if (slug !== value) onCommit(slug);
  };

  return (
    <p className="field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        value={draft}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          setTyping(true);
        }}
        onBlur={() => {
          const candidate = draft.trim();
          if (candidate !== "" && (status === null || status.available)) commit(candidate);
        }}
      />
      {status && !status.available && (
        <span className="settings__slug-hint">
          {t("settings.slug_taken")}{" "}
          {/* Подсказка — кнопка, а не текст: прочитать свободный вариант и
              перепечатать его руками человек может и без нас. */}
          <button type="button" className="button--quiet" onClick={() => commit(status.suggestion)}>
            {status.suggestion}
          </button>
        </span>
      )}
      {/* Занятый слаг уже объяснён подсказкой рядом: вторая строка про то же
          самое — шум. */}
      {!(status && !status.available) && <SaveMark save={typing ? undefined : save} />}
    </p>
  );
}
