// The Settings window draws its nav in the same leading frame as the main
// window's sidebar, from its OWN root (it does not mount AppShell). So the
// sidebar style has to reach it separately — and a root that kept passing a
// fixed style would leave this window a card while the main one went flat.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { SettingsPage } from "./Settings";
import { useSettingsStore } from "@/stores/settingsStore";
import { SHELL_CARD_INSET, SHELL_CARD_RADIUS } from "@/shell/shellChrome";

/** The element that publishes the shell chrome vars for the whole window. */
function chromeRoot(container: HTMLElement): HTMLElement {
  const root = Array.from(container.querySelectorAll<HTMLElement>("[style]")).find((el) =>
    el.style.getPropertyValue("--shell-card-inset"),
  );
  if (!root) throw new Error("the Settings window published no shell chrome vars");
  return root;
}

beforeEach(() => {
  useSettingsStore.getState().resetSettings();
  window.history.replaceState(null, "", "/?section=appearance");
  vi.mocked(invoke).mockImplementation(() => Promise.resolve([]));
});
afterEach(() => {
  window.history.replaceState(null, "", "/");
  vi.mocked(invoke).mockImplementation(() => Promise.resolve());
});

describe("SettingsPage — the nav follows the sidebar style", () => {
  it("publishes the flat frame by default", () => {
    const root = chromeRoot(render(<SettingsPage />).container);
    expect(root.style.getPropertyValue("--shell-card-inset")).toBe("0px");
    expect(root.style.getPropertyValue("--shell-card-radius")).toBe("0px");
    expect(root.style.getPropertyValue("--shell-card-shadow")).toBe("none");
  });

  it("publishes the card when chosen", () => {
    useSettingsStore.getState().updateAppearanceSetting("sidebarStyle", "card");
    const root = chromeRoot(render(<SettingsPage />).container);
    expect(root.style.getPropertyValue("--shell-card-inset")).toBe(`${SHELL_CARD_INSET}px`);
    expect(root.style.getPropertyValue("--shell-card-radius")).toBe(`${SHELL_CARD_RADIUS}px`);
  });
});
