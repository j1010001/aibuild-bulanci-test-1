// Minimal element builder. Text only ever goes in through text nodes, never innerHTML:
// player names come from other clients and must not be interpreted as markup.

type Child = Node | string | number | null | undefined | false;

export type Props = {
  class?: string;
  title?: string;
  disabled?: boolean;
  value?: string;
  type?: string;
  placeholder?: string;
  maxLength?: number;
  min?: number;
  max?: number;
  checked?: boolean;
  style?: Partial<Record<'background' | 'color' | 'borderColor', string>>;
  data?: Record<string, string>;
  on?: Partial<Record<'click' | 'input' | 'change' | 'keydown', (e: Event) => void>>;
};

export function h(tag: string, props: Props = {}, children: Child[] = []): HTMLElement {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.title) el.title = props.title;
  if (props.style) Object.assign(el.style, props.style);
  if (props.data) for (const [k, v] of Object.entries(props.data)) el.dataset[k] = v;
  if (el instanceof HTMLInputElement || el instanceof HTMLButtonElement || el instanceof HTMLSelectElement) {
    if (props.disabled !== undefined) el.disabled = props.disabled;
  }
  if (el instanceof HTMLInputElement) {
    if (props.type) el.type = props.type;
    if (props.value !== undefined) el.value = props.value;
    if (props.placeholder) el.placeholder = props.placeholder;
    if (props.maxLength !== undefined) el.maxLength = props.maxLength;
    if (props.min !== undefined) el.min = String(props.min);
    if (props.max !== undefined) el.max = String(props.max);
    if (props.checked !== undefined) el.checked = props.checked;
  }
  if (el instanceof HTMLButtonElement) el.type = 'button';
  for (const [event, handler] of Object.entries(props.on ?? {})) el.addEventListener(event, handler as EventListener);
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' || typeof child === 'number' ? document.createTextNode(String(child)) : child);
  }
  return el;
}

export function option(value: string, label: string, selected: boolean): HTMLOptionElement {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  o.selected = selected;
  return o;
}
