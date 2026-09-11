type FieldProps = {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  /** The value was not set by a person — the address an invitation is tied to, for example. */
  readOnly?: boolean;
  /** The field's styling, set by the place it is used in. */
  className?: string;
};

/**
 * A field with a real caption rather than a placeholder instead of one: a placeholder disappears on the
 * very first character, is not read from the screen and is not tied to the field.
 */
export function Field({
  id,
  label,
  type = "text",
  value,
  onChange,
  autoComplete,
  required,
  readOnly,
  className,
}: FieldProps) {
  return (
    <p className={`field ${className ?? ""}`.trimEnd()}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        name={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        required={required}
        readOnly={readOnly}
        onChange={(event) => onChange(event.target.value)}
      />
    </p>
  );
}
