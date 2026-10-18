/**
 * A tiny element builder, so the app needs no framework.
 */

export type Child = Node | string | false | undefined

export interface Props {
  readonly class?: string
  readonly attrs?: Readonly<Record<string, string | boolean>>
  readonly on?: Readonly<Record<string, (event: Event) => void>>
}

/** A `tag` element with `props` and `children`; `false` and `undefined` children are skipped. */
export const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  children: ReadonlyArray<Child> = [],
): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag)
  if (props.class !== undefined) element.className = props.class
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === true) element.setAttribute(name, '')
    else if (value !== false) element.setAttribute(name, value)
  }
  for (const [name, listener] of Object.entries(props.on ?? {})) {
    element.addEventListener(name, listener)
  }
  for (const child of children) {
    if (child !== false && child !== undefined) element.append(child)
  }
  return element
}

/** The value of a form field. */
export const valueOf = (form: HTMLFormElement, name: string): string => {
  const field = form.elements.namedItem(name)
  return field instanceof HTMLInputElement || field instanceof HTMLSelectElement
    ? field.value.trim()
    : ''
}
