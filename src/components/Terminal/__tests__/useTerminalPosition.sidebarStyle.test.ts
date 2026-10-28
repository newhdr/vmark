// The terminal sizes itself against the chrome left of the editor, and the
// sidebar style changes that chrome: "card" adds two gutters, "flat" none. Run
// against the REAL stores (the sibling suite hand-rolls them) so the test can
// see both halves of the contract — that the width follows the style, and that
// the hook re-runs when the style flips. Missing either one sizes a right-docked
// panel against 16px it does not have, which is the class of bug shellChrome
// was created to end.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useSettingsStore } from "@/stores/settingsStore";
import { useUIStore } from "@/stores/uiStore";
import { SHELL_CARD_INSET } from "@/shell/shellChrome";
import { currentShellSideWidth, useTerminalPosition } from "../useTerminalPosition";

vi.mock("@/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/platform")>()),
  usesOverlayTitleBar: () => true,
}));

const SIDEBAR = 260;

function setStyle(sidebarStyle: "flat" | "card") {
  useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, sidebarStyle } }));
}

beforeEach(() => {
  Object.defineProperty(window, "innerWidth", { value: 1600, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: 900, configurable: true });
  useSettingsStore.setState((s) => ({
    general: { ...s.general, workspaceRailMode: false },
    terminal: { ...s.terminal, position: "right", panelRatio: 0.5 },
  }));
  useUIStore.setState({ sidebarVisible: true, sidebarWidth: SIDEBAR });
  setStyle("flat");
});

describe("terminal sizing follows the sidebar style", () => {
  it("currentShellSideWidth charges the gutters only in card mode", () => {
    expect(currentShellSideWidth()).toBe(SIDEBAR);
    setStyle("card");
    expect(currentShellSideWidth()).toBe(SIDEBAR + SHELL_CARD_INSET * 2);
  });

  it("re-sizes a right-docked panel when the style flips", () => {
    renderHook(() => useTerminalPosition());
    const flat = useUIStore.getState().terminalWidth;
    expect(flat).toBe((1600 - SIDEBAR) * 0.5);

    act(() => setStyle("card"));
    expect(useUIStore.getState().terminalWidth).toBe((1600 - SIDEBAR - SHELL_CARD_INSET * 2) * 0.5);
  });
});
