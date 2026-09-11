/**
 * An on/off toggle.
 *
 * `role="switch"` rather than a checkbox: a checkbox answers the question "should this item be ticked",
 * while here the state changes at once and with no "save" button — this is a switch, and it should be
 * declared as what it is.
 *
 * The caption is tied to the control through `aria-labelledby` rather than repeated in `aria-label`: a
 * copy of the caption will one day diverge from the visible text, and what is read from the screen will
 * not be what is written on it.
 */
export function Switch({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <p className="switch">
      <span className="switch__label" id={`${id}-label`}>
        {label}
      </span>
      <button
        type="button"
        id={id}
        role="switch"
        aria-checked={checked}
        aria-labelledby={`${id}-label`}
        disabled={disabled}
        className="switch__handle"
        onClick={() => onChange(!checked)}
      >
        <span className="switch__dot" />
      </button>
    </p>
  );
}
