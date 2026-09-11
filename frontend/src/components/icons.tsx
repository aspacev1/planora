import type { ReactNode } from "react";

/**
 * The interface's icons.
 *
 * Drawn here rather than taken from a library: each is a few lines of markup, and there is
 * no point adding a dependency with a hundred unused ones for the sake of eight drawings.
 *
 * They all lie in one place rather than at their points of use: "settings" is drawn both in
 * the sidebar and in the project's header, and two different drawings of one notion on one
 * screen read as two different notions.
 *
 * They are all `aria-hidden`: a word stands next to each, and an icon read aloud would only
 * repeat it.
 */

type IconProps = {
  /** A class for the size and the colour. By default the buttons' shared `.icon`. */
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

/* A tick in a circle: "my tasks" is what will be asked of me. */
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

/* A door and an arrow outwards: a drawing of a lock would mean "locked" rather than "sign
   out". The arrow points to the right, away from the doorway — the direction of the action is read from it. */
export function IconExit({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M9.5 2.5h-5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h5" />
      <path d="M11 5.5 13.5 8 11 10.5" />
      <path d="M13.5 8h-6" />
    </Icon>
  );
}

/* Sliders rather than a cog: a cog at sixteen pixels degenerates into an asterisk and reads
   as "favourites". */
export function IconSettings({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M2.5 4.5h11M2.5 11.5h11" />
      <circle cx="6" cy="4.5" r="1.8" />
      <circle cx="10.5" cy="11.5" r="1.8" />
    </Icon>
  );
}

/* Three nodes and two links between them — the commonly accepted drawing for "share". A chain
   of links would mean "a link" in general: it is used where two tasks are linked too, while
   here it is about giving the project outwards. */
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

/* A shield: the director's panel is about oversight of the whole install rather than about
   configuring one place of work, and the cog of the neighbouring "Settings" would repeat here
   the meaning it has already taken. */
export function IconShield({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M8 1.8 13 3.6v4c0 3.4-2.1 5.9-5 6.6-2.9-.7-5-3.2-5-6.6v-4Z" />
      <path d="m5.7 8 1.6 1.6L10.3 6.4" />
    </Icon>
  );
}

/* A person with a plus: an invitation adds people to the organization, not emails. An envelope
   next to the word "Invite" would promise an email to be sent — while an invitation with no
   address goes as a link. */
export function IconInvite({ className }: IconProps) {
  return (
    <Icon className={className}>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M2 13.5a4 4 0 0 1 8 0" />
      <path d="M12.5 5v4M10.5 7h4" />
    </Icon>
  );
}

/* A down arrow into a tray. The download sign rather than "save": the file travels from the
   application to the person, not the other way round. */
export function IconDownload({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M8 2.5v7" />
      <path d="m5 6.5 3 3 3-3" />
      <path d="M3 12.5h10" />
    </Icon>
  );
}

/* A double left arrow: a single one in a row of links reads as "back", while a pair reads as
   "fold to the edge". It points where the column will travel, and appears only under the
   cursor: a permanent arrow in the very top line would compete for attention with the
   organization's name. */
export function IconCollapse({ className }: IconProps) {
  return (
    <Icon className={className}>
      <path d="M7.5 4.5 4 8l3.5 3.5" />
      <path d="M12 4.5 8.5 8l3.5 3.5" />
    </Icon>
  );
}

/* Arrows into the corners: "expand to full screen". A diagonal rather than a frame with an
   arrow inside — a frame is already worn by the buttons in this row, and a second would read
   as part of them. */
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

/* The same arrows brought inwards: leaving full screen is the same motion in reverse, and it
   is recognized by the turn rather than by a different drawing. */
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

/* A calendar: moving the start date. A sheet with rings on top rather than a grid of days —
   at fourteen pixels a grid merges into a grey blot. */
export function IconCalendar({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 7h11" />
      <path d="M5.5 2v3M10.5 2v3" />
    </Icon>
  );
}

/* A lock: the "team only" section in a quote line's card. The shackle and the body, without a
   keyhole — at fourteen pixels it would read as a blot. */
export function IconLock({ className }: IconProps) {
  return (
    <Icon className={className}>
      <rect x="3.5" y="7" width="9" height="6.5" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </Icon>
  );
}
