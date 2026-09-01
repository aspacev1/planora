import type { ReactNode } from "react";

/**
 * Значки интерфейса.
 *
 * Нарисованы здесь, а не взяты библиотекой: каждый — несколько строк разметки,
 * и ради восьми рисунков ставить зависимость с сотней неиспользованных не за
 * что.
 *
 * Лежат все в одном месте, а не по местам употребления: «настройки» рисуются и
 * в боковой колонке, и в шапке проекта, и два разных рисунка одного понятия на
 * одном экране читаются как два разных понятия.
 *
 * Все они `aria-hidden`: рядом стоит слово, и прочитанный вслух значок только
 * повторил бы его.
 */

type IconProps = {
  /** Класс для размеров и цвета. По умолчанию — общий `.icon` кнопок. */
  className?: string;
};

function Icon({ className = "icon", children }: IconProps & { children: ReactNode }) {
  return (
    <svg
      className={className}
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

/* Галочка в круге: «мои задачи» — это то, что с меня спросят. */
export function IconCheck({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="8" cy="8" r="6" />
      <path d="m5.5 8.2 1.8 1.8 3.2-3.6" />
    </Icon>
  );
}

export function IconBoard({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6h12M6.5 6v7.5" />
    </Icon>
  );
}

/* Дверь и стрелка наружу: рисунок замка означал бы «заперто», а не «выйти».
   Стрелка смотрит вправо, от проёма, — по ней читается направление действия. */
export function IconExit({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5" />
      <path d="M11 5.5 13.5 8 11 10.5" />
      <path d="M13.5 8h-6" />
    </Icon>
  );
}

/* Ползунки, а не шестерня: шестерня в шестнадцати пикселях вырождается в
   звёздочку и читается как «избранное». */
export function IconSettings({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="10.5" cy="11.5" r="1.8" />
    </Icon>
  );
}

/* Три узла и две связи между ними — общепринятый рисунок «поделиться». Цепь
   звеньями означала бы «ссылка» вообще: её ставят и там, где связывают две
   задачи, а здесь речь про отдачу проекта наружу. */
export function IconShare({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="11.5" cy="3.5" r="1.8" />
      <circle cx="4.5" cy="8" r="1.8" />
      <circle cx="11.5" cy="12.5" r="1.8" />
      <path d="m6 7 4-2.5M6 9l4 2.5" />
    </Icon>
  );
}

/* Щит: панель директора — про надзор за всей установкой, а не про настройку
   одного места работы, и шестерёнка соседних «Настроек» здесь повторила бы
   уже занятый ею смысл. */
export function IconShield({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M8 1.8 13 3.6v4c0 3.4-2.1 5.9-5 6.6-2.9-.7-5-3.2-5-6.6v-4Z" />
      <path d="m5.7 8 1.6 1.6L10.3 6.4" />
    </Icon>
  );
}

/* Человек с плюсом: приглашение добавляет в организацию людей, а не письма.
   Конверт рядом со словом «Пригласить» обещал бы отправку письма — а
   приглашение без адреса уходит ссылкой. */
export function IconInvite({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M2 13.5a4 4 0 0 1 8 0" />
      <path d="M12.5 5v4M10.5 7h4" />
    </Icon>
  );
}

/* Стрелка вниз в лоток. Знак скачивания, а не «сохранить»: файл уезжает из
   приложения к человеку, а не наоборот. */
export function IconDownload({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M8 2.5v7" />
      <path d="m5 6.5 3 3 3-3" />
      <path d="M3 12.5h10" />
    </Icon>
  );
}

/* Двойная стрелка влево: одинарная в ряду ссылок читается как «назад», а пара
   — как «сложить к краю». Смотрит туда, куда уедет колонка, и появляется
   только под курсором: постоянная стрелка в самой верхней строке спорила бы за
   внимание с названием организации. */
export function IconCollapse({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M7.5 4.5 4 8l3.5 3.5" />
      <path d="M12 4.5 8.5 8l3.5 3.5" />
    </Icon>
  );
}

/* Стрелки в углы: «развернуть на весь экран». Диагональ, а не рамка со
   стрелкой внутри, — рамку в этом ряду уже носят кнопки, и вторая читалась бы
   их частью. */
export function IconExpand({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9.5 2.5H13.5V6.5" />
      <path d="M6.5 13.5H2.5V9.5" />
      <path d="M13.5 2.5 9.5 6.5" />
      <path d="M2.5 13.5 6.5 9.5" />
    </Icon>
  );
}

/* Те же стрелки, сведённые внутрь: выход из полного экрана — то же движение
   наоборот, и узнаётся оно по развороту, а не по другому рисунку. */
export function IconShrink({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M13 3 9.5 6.5H13.5" />
      <path d="M9.5 6.5V2.5" />
      <path d="M3 13 6.5 9.5H2.5" />
      <path d="M6.5 9.5V13.5" />
    </Icon>
  );
}
