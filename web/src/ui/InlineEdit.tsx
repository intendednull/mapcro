// Text edited where it's shown: click to type, Enter or leaving commits, Escape cancels.

import { type JSX, Show, createSignal } from "solid-js";

export function InlineEdit(p: {
  value: string;
  /** Shown when the value is empty. */
  placeholder?: string;
  editable: boolean;
  maxLength?: number;
  class?: string;
  label: string;
  testid?: string;
  /** Return false to keep the editor open (the text didn't parse). */
  onCommit: (text: string) => boolean | void;
  onEditing?: (editing: boolean) => void;
  display?: (v: string) => JSX.Element;
}) {
  const [editing, setEditing] = createSignal(false);
  const [bad, setBad] = createSignal(false);
  const open = () => {
    if (!p.editable) return;
    setBad(false);
    setEditing(true);
    p.onEditing?.(true);
  };
  const close = () => {
    setEditing(false);
    p.onEditing?.(false);
  };
  const commit = (el: HTMLInputElement) => {
    if (!editing()) return;
    if (el.value !== p.value && p.onCommit(el.value) === false) {
      setBad(true);
      return;
    }
    close();
  };
  return (
    <Show
      when={editing()}
      fallback={
        <span
          class={`ie ${p.class ?? ""}`}
          classList={{ editable: p.editable, empty: !p.value }}
          data-testid={p.testid}
          role={p.editable ? "button" : undefined}
          tabIndex={p.editable ? 0 : undefined}
          title={p.editable ? `Click to edit the ${p.label}` : undefined}
          onClick={open}
          onKeyDown={(e) => e.key === "Enter" && open()}
        >
          {p.value ? (p.display ? p.display(p.value) : p.value) : (p.placeholder ?? "")}
        </span>
      }
    >
      <input
        class={`ie-input ${p.class ?? ""}`}
        classList={{ bad: bad() }}
        data-testid={p.testid && `${p.testid}-input`}
        aria-label={p.label}
        value={p.value}
        maxLength={p.maxLength}
        size={Math.max(4, p.value.length + 1)}
        ref={(el) => queueMicrotask(() => (el.focus(), el.select()))}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") commit(e.currentTarget);
          if (e.key === "Escape") close();
        }}
        onBlur={(e) => (bad() ? close() : commit(e.currentTarget))}
      />
    </Show>
  );
}
