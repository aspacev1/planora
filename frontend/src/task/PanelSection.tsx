import type { ReactNode } from "react";

/**
 * The card's accordion: a heading panel and the content under it.
 *
 * A native `details`: the panel is keyboard-accessible and read aloud without a single line of script.
 * Unfolded from the start — an accordion here is a way to fold away what has been read rather than to
 * hide fields by default.
 *
 * Shared by the task card and the quote line's card: two panels with different markup would diverge on
 * the first edit of the chevron.
 */
export function PanelSection({
  title,
  icon,
  note,
  children,
}: {
  title: string;
  /** An icon before the heading — the lock on the "team only" section, for example. */
  icon?: ReactNode;
  /** An explanation in small type after the heading: who can see the content. */
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
