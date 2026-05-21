import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR =
  'a[href], area[href], input:not([disabled]):not([type="hidden"]),' +
  ' select:not([disabled]), textarea:not([disabled]),' +
  ' button:not([disabled]), iframe, object, embed,' +
  ' [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter((el) => !el.hasAttribute("inert") && el.offsetParent !== null);
}

/** Attach to a modal's outermost element. Adds Esc-to-close, traps Tab focus
 *  inside, moves initial focus into the dialog, and restores focus to the
 *  previously focused element when the modal unmounts. */
export function useModal(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Move focus inside. Prefer an explicitly-marked autofocus target, then
    // the first focusable, otherwise the dialog container itself (needs a
    // tabindex on the consumer to receive focus; falls back to body otherwise).
    const autofocus = node.querySelector<HTMLElement>("[data-autofocus]");
    const first = autofocus ?? focusableIn(node)[0] ?? node;
    first.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const focusables = focusableIn(node);
      if (focusables.length === 0) {
        e.preventDefault();
        return;
      }
      const firstEl = focusables[0];
      const lastEl = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && active === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && active === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    node.addEventListener("keydown", onKey);
    return () => {
      node.removeEventListener("keydown", onKey);
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return ref;
}
