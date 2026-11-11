// The scrim every modal dialog sits on (Share, Clone, the hero picker, Join, Feedback): mounted
// at <body> through a Portal and made modal (ui/modal.ts `useModal`). A press on the scrim
// itself closes the dialog when it can be closed. The dialog inside carries role="dialog",
// aria-modal="true" and `dialogKeys`.
import type { JSX } from "solid-js";
import { Portal } from "solid-js/web";
import { cx } from "./cx";
import { useModal } from "./modal";

export function ModalScrim(p: { class?: string; testid: string; onClose?: (() => void) | undefined; children: JSX.Element }) {
  let scrim!: HTMLDivElement;
  useModal(() => scrim);
  return (
    <Portal>
      <div ref={scrim} class={cx("scrim", p.class)} data-testid={p.testid} onPointerDown={(e) => e.target === e.currentTarget && p.onClose?.()}>
        {p.children}
      </div>
    </Portal>
  );
}
