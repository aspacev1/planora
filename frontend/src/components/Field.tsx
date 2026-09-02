type FieldProps = {
  id: string;
  label: string;
  type?: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete?: string;
  required?: boolean;
  /** Значение задано не человеком — например, адрес, к которому привязано приглашение. */
  readOnly?: boolean;
  /** Оформление поля, заданное местом применения. */
  className?: string;
};

/**
 * Поле с настоящей подписью, а не с плейсхолдером вместо неё: плейсхолдер
 * исчезает при первом же символе, не читается с экрана и не связан с полем.
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
