// WI-AL3.2 — the focus facts measured in real WebKit with a real pointer: a mouse click focuses no button; a focused button that becomes disabled falls to the page with a focusout in the next rendering update, after its animation-frame callbacks, unless re-enabled before it; a click elsewhere takes focus from a focused textarea or button to the page with a focusout; focus() on a disabled button does nothing; removing the focused element moves focus to the page with no focusout
import { userEvent } from "vitest/browser";
import { describeFocusFacts } from "./focusFacts";

const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

describeFocusFacts({
  name: "WebKit",
  click: async (el) => {
    await userEvent.click(el);
  },
  settle: async () => {
    await frame();
    await frame();
  },
});
