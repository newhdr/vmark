/**
 * Focus facts — the WebKit focus behaviours the comments panel's focus model
 * relies on, written once as a spec that runs against any engine: real WebKit
 * with a real pointer, and jsdom with the WebKit focus model installed. A fact
 * the two disagree on fails one of the two runs.
 *
 * Each case compares one observation record (where focus is, how many
 * `focusout` events fired, the order events arrived in), so a failure prints
 * what the engine did. The traces pin order, not only outcome: a model that
 * reaches the right focus by a different sequence of events fails them.
 *
 * @coordinates-with test/focusFacts.webkit.test.ts — the measurement in real WebKit
 * @coordinates-with test/webkitFocusModel.ts — the jsdom model held to the same facts
 * @module test/focusFacts
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createElement, useLayoutEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

export interface FocusEngine {
  name: string;
  /** A mouse click on `el`, as the engine delivers one. */
  click(el: HTMLElement): Promise<void>;
  /** Let deferred focus work (blur of a disabled control) happen. */
  settle(): Promise<void>;
}

/** A button whose `disabled` follows React state; `reenable` turns it back on from the layout effect of the commit that disabled it. */
function BusyButton({ log, reenable, expose }: { log: (entry: string) => void; reenable: boolean; expose: (set: (busy: boolean) => void) => void }) {
  const [busy, setBusy] = useState(false);
  expose(setBusy);
  useLayoutEffect(() => {
    log(`layoutEffect busy=${busy}`);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the case under measurement: a re-enable from the layout effect of the commit that disabled
    if (reenable && busy) setBusy(false);
  }, [busy, log, reenable]);
  return createElement("button", { id: "b", disabled: busy }, "b");
}

/** Where focus is, by name: `body` when it has fallen to the page. */
function where(): string {
  const el = document.activeElement;
  if (el === null || el === document.body) return "body";
  return el.id || el.tagName.toLowerCase();
}

export function describeFocusFacts(engine: FocusEngine): void {
  describe(`focus facts (${engine.name})`, () => {
    let host: HTMLElement;
    const add = <K extends keyof HTMLElementTagNameMap>(tag: K, id: string): HTMLElementTagNameMap[K] => {
      const el = document.createElement(tag);
      el.id = id;
      if (el instanceof HTMLButtonElement) el.textContent = id;
      host.appendChild(el);
      return el;
    };
    /** Count `focusout` events dispatched on `el`. */
    const countFocusOut = (el: HTMLElement) => {
      const seen = { n: 0 };
      el.addEventListener("focusout", () => seen.n++);
      return seen;
    };

    beforeEach(() => {
      (document.activeElement as HTMLElement | null)?.blur?.();
      host = document.createElement("div");
      document.body.appendChild(host);
    });
    afterEach(() => host.remove());

    it("F1: a mouse click does not focus the clicked button", async () => {
      const b = add("button", "b");
      await engine.click(b);
      await engine.settle();
      expect({ focus: where() }).toEqual({ focus: "body" });
    });

    it("F2 and F2b: a focused button that becomes disabled falls to the page, with a focusout", async () => {
      const b = add("button", "b");
      b.focus();
      expect(where()).toBe("b");
      const out = countFocusOut(b);
      b.disabled = true;
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 1 });
    });

    it("F3: a mouse click elsewhere moves focus from a focused textarea to the page, with a focusout", async () => {
      const area = add("textarea", "area");
      const other = add("button", "other");
      area.focus();
      expect(where()).toBe("area");
      const out = countFocusOut(area);
      await engine.click(other);
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 1 });
    });

    it("F3b: a mouse click elsewhere moves focus from a focused button to the page, with a focusout", async () => {
      const b = add("button", "b");
      const other = add("button", "other");
      b.focus();
      expect(where()).toBe("b");
      const out = countFocusOut(b);
      await engine.click(other);
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 1 });
    });

    it("F3c: a mouse click elsewhere moves focus from a focused button just disabled to the page, with one focusout", async () => {
      const b = add("button", "b");
      const other = add("button", "other");
      b.focus();
      const out = countFocusOut(b);
      b.disabled = true;
      await engine.click(other);
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 1 });
    });

    it("F4: focus() on a disabled button does nothing", async () => {
      const b = add("button", "b");
      b.disabled = true;
      b.focus();
      await engine.settle();
      expect({ focus: where() }).toEqual({ focus: "body" });
    });

    /**
     * Start in a fresh task just after a frame. A control disabled inside a
     * rendering update still running loses focus in that same update, so a
     * timing case that did not start here would measure where the previous
     * case left off.
     */
    const afterFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    /** Record, in order, the events of `types` reaching `target` (capture phase). */
    const record = (target: EventTarget, types: string[], log: string[]) => {
      for (const type of types) target.addEventListener(type, (e) => log.push(`${type}${e.target instanceof Element && e.target.id ? `@${e.target.id}` : ""}`), true);
    };
    /** Mount `BusyButton`, focused; returns its state setter and the log. */
    const mountBusy = (reenable: boolean) => {
      const log: string[] = [];
      let set: (busy: boolean) => void = () => undefined;
      const root: Root = createRoot(host);
      flushSync(() => root.render(createElement(BusyButton, { log: (e) => log.push(e), reenable, expose: (s) => (set = s) })));
      const b = host.querySelector<HTMLButtonElement>("#b");
      if (!b) throw new Error("BusyButton did not render");
      b.focus();
      log.length = 0;
      return { b, log, root, set: (busy: boolean) => flushSync(() => set(busy)) };
    };

    it("F2c: a focused button disabled and re-enabled in the same task keeps focus", async () => {
      await afterFrame();
      const b = add("button", "b");
      b.focus();
      const out = countFocusOut(b);
      b.disabled = true;
      b.disabled = false;
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "b", focusout: 0 });
    });

    it("F2c: a focused button disabled, then re-enabled in the next task before a frame, keeps focus", async () => {
      await afterFrame();
      const b = add("button", "b");
      b.focus();
      const out = countFocusOut(b);
      let frames = 0;
      requestAnimationFrame(() => frames++);
      b.disabled = true;
      await new Promise((resolve) => setTimeout(resolve, 0));
      const framesBetween = frames;
      b.disabled = false;
      await engine.settle();
      expect({ framesBetween, focus: where(), focusout: out.n }).toEqual({ framesBetween: 0, focus: "b", focusout: 0 });
    });

    it("F2c: a focused button disabled by a React commit and re-enabled from its layout effect keeps focus", async () => {
      await afterFrame();
      const { b, log, root, set } = mountBusy(true);
      const out = countFocusOut(b);
      set(true);
      await engine.settle();
      expect({ focus: where(), focusout: out.n, log }).toEqual({ focus: "b", focusout: 0, log: ["layoutEffect busy=true", "layoutEffect busy=false"] });
      root.unmount();
    });

    it("F5b: removing the focused textarea moves focus to the page with no focusout", async () => {
      const area = add("textarea", "area");
      area.focus();
      const out = countFocusOut(area);
      area.remove();
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 0 });
    });

    it("F5c: removing a focused textarea mid-composition fires no compositionend, blur or focusout", async () => {
      const area = add("textarea", "area");
      area.focus();
      const log: string[] = [];
      record(document, ["compositionstart", "compositionupdate", "compositionend", "input", "blur", "focusout"], log);
      area.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true, data: "" }));
      area.remove();
      await engine.settle();
      expect({ focus: where(), log }).toEqual({ focus: "body", log: ["compositionstart@area"] });
    });

    it("trace: the disable path — the blur lands in the next rendering update, after its frame callbacks", async () => {
      await afterFrame();
      const { log, root, set } = mountBusy(false);
      const observer = new MutationObserver(() => log.push("mutationObserver"));
      observer.observe(host, { attributes: true, attributeFilter: ["disabled"], subtree: true });
      record(document, ["blur", "focusout"], log);
      requestAnimationFrame(() => log.push("rAF"));
      set(true);
      log.push("commit returned");
      await engine.settle();
      observer.disconnect();
      root.unmount();
      expect({ focus: where(), log }).toEqual({
        focus: "body",
        log: ["layoutEffect busy=true", "commit returned", "mutationObserver", "rAF", "blur@b", "focusout@b"],
      });
    });

    it("trace: a disable made while a frame is under way loses focus in that same frame", async () => {
      await afterFrame();
      const b = add("button", "b");
      b.focus();
      const log: string[] = [];
      record(document, ["blur", "focusout"], log);
      const second = new Promise<void>((resolve) => {
        requestAnimationFrame(() => {
          log.push("rAF 1");
          void Promise.resolve().then(() => {
            b.disabled = true;
            log.push("disabled");
            requestAnimationFrame(() => {
              log.push("rAF 2");
              resolve();
            });
          });
        });
      });
      await second;
      await engine.settle();
      expect({ focus: where(), log }).toEqual({ focus: "body", log: ["rAF 1", "disabled", "blur@b", "focusout@b", "rAF 2"] });
    });

    it("trace: the click path, from a focused button to a click on another", async () => {
      const b = add("button", "b");
      const other = add("button", "other");
      b.focus();
      const log: string[] = [];
      record(document, ["pointerdown", "mousedown", "blur", "focusout", "focusin", "pointerup", "mouseup", "click"], log);
      await engine.click(other);
      await engine.settle();
      expect({ focus: where(), log }).toEqual({
        focus: "body",
        log: ["pointerdown@other", "mousedown@other", "blur@b", "focusout@b", "pointerup@other", "mouseup@other", "click@other"],
      });
    });

    it("F5: removing the focused button moves focus to the page with no focusout", async () => {
      const b = add("button", "b");
      b.focus();
      expect(where()).toBe("b");
      const out = countFocusOut(b);
      b.remove();
      await engine.settle();
      expect({ focus: where(), focusout: out.n }).toEqual({ focus: "body", focusout: 0 });
    });
  });
}
