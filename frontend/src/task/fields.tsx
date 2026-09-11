import type { ComponentProps } from "react";

import {
  SelectField as BaseSelectField,
  TextField as BaseTextField,
  ValueField as BaseValueField,
} from "../components/autosave";

/**
 * The task card's fields.
 *
 * The fields themselves are shared — the same ones stand in the settings (see `components/autosave`),
 * and a second set of them would diverge from the first on the first edit. The card has one thing of its
 * own: the row's layout. In the settings the caption stands above the field, in the card to its left,
 * because a task has eight properties and captions on top give eight extra lines, after which the card
 * stops fitting on the screen.
 */

const ROW = "panel__field";

/** The same props as the shared field's, except the layout: that is set by the card. */
type Panel<Props> = Omit<Props, "className">;

export function TextField(props: Panel<ComponentProps<typeof BaseTextField>>) {
  return <BaseTextField className={ROW} {...props} />;
}

export function ValueField(props: Panel<ComponentProps<typeof BaseValueField>>) {
  return <BaseValueField className={ROW} {...props} />;
}

export function SelectField(props: Panel<ComponentProps<typeof BaseSelectField>>) {
  return <BaseSelectField className={ROW} {...props} />;
}
