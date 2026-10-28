// WI-RA9B.5 — dragging the sidebar edge must not re-render MainLayout per
// pointer move. The drag paints the live width onto the layout's own DOM and
// commits to the store once, on release.
//
// Rendered with the REAL AppShell and the REAL resize handle, so the test also
// pins the contract the live preview depends on: what the drag paints during
// the gesture is exactly what React renders after the commit.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

/** One call per MainLayout render — `useTheme` is called unconditionally by it. */
const layoutRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/platform")>()),
  usesOverlayTitleBar: () => false,
}));
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/WorkspaceRail", () => ({ WorkspaceRail: () => null }));
vi.mock("@/components/BottomBar/BottomBar", () => ({ BottomBar: () => null }));
vi.mock("@/components/CoherenceOverlays", () => ({ CoherenceOverlays: () => null }));
vi.mock("@/components/GeniePicker/GeniePickerOverlay", () => ({ GeniePickerOverlay: () => null }));
vi.mock("@/components/KnowledgeBasePanel/KnowledgeBaseOverlay", () => ({
  KnowledgeBaseOverlay: () => null,
}));
vi.mock("@/components/WindowStatusPanel/WindowStatusOverlay", () => ({
  WindowStatusOverlay: () => null,
}));
vi.mock("@/hooks/lifecycle", () => ({
  useWorkspaceLifecycle: () => {},
  useEditorLifecycle: () => {},
  DocumentWindowMount: () => null,
  MainWindowRunners: () => null,
}));
vi.mock("@/hooks/useTheme", () => ({
  useTheme: () => {
    layoutRenders.count += 1;
  },
  FOCUS_DIM_OPACITY: {},
}));
vi.mock("@/hooks/useTabModeSync", () => ({ useTabModeSync: () => {} }));
vi.mock("@/hooks/useWindowStatus", () => ({ useWindowStatus: () => {} }));
vi.mock("@/contexts/WindowContext", () => ({
  WindowProvider: ({ children }: { children: unknown }) => children,
  useIsDocumentWindow: () => true,
  useWindowLabel: () => "main",
}));

const { MainLayout } = await import("./App");
const { useUIStore } = await import("@/stores/uiStore");
const { useSettingsStore } = await import("@/stores/settingsStore");

const { shellSideWidth } = await import("@/shell/shellChrome");

/** The shell's own derivation of the leading column's width, as a CSS length. */
function side(workspaceRailVisible: boolean, sidebarWidth: number, sidebarVisible = true): string {
  const sidebarStyle = useSettingsStore.getState().appearance.sidebarStyle;
  return `${shellSideWidth({ workspaceRailVisible, sidebarVisible, sidebarWidth, sidebarStyle })}px`;
}

function mouseMove(clientX: number): void {
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
  });
}

/** The three places the sidebar width is laid out from. */
function layoutWidths(container: HTMLElement) {
  const shell = container.querySelector<HTMLElement>(".app-shell");
  const aside = container.querySelector<HTMLElement>(".app-shell__sidebar");
  const column = container.querySelector<HTMLElement>(".app-sidebar-stack__sidebar");
  return {
    column: column?.style.width,
    aside: aside?.style.width,
    asideMin: aside?.style.minWidth,
    shellVar: shell?.style.getPropertyValue("--shell-side-width"),
    ariaNow: screen.getByRole("separator").getAttribute("aria-valuenow"),
  };
}

function mountWithSidebar(railVisible: boolean) {
  useSettingsStore.getState().updateGeneralSetting("workspaceRailMode", railVisible);
  act(() => {
    useUIStore.setState({ sidebarVisible: true });
    useUIStore.getState().setSidebarWidth(250);
  });
  const view = render(<MainLayout />);
  return { ...view, handle: screen.getByRole("separator") };
}

beforeEach(() => {
  window.innerWidth = 1400;
  window.innerHeight = 900;
  layoutRenders.count = 0;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
});

describe("MainLayout — sidebar edge drag", () => {
  it.each([
    ["with the workspace rail", true],
    ["without the workspace rail", false],
  ])("does not re-render the layout per pointer move (%s)", (_name, railVisible) => {
    const { container, handle } = mountWithSidebar(railVisible);
    expect(layoutWidths(container)).toEqual({
      column: "250px",
      aside: side(railVisible, 250),
      asideMin: side(railVisible, 250),
      shellVar: side(railVisible, 250),
      ariaNow: "250",
    });
    const rendersBeforeDrag = layoutRenders.count;

    fireEvent.mouseDown(handle, { clientX: 300 });
    mouseMove(340);
    mouseMove(360);
    mouseMove(380);

    // The layout follows the pointer…
    const live = layoutWidths(container);
    expect(live).toEqual({
      column: "330px",
      aside: side(railVisible, 330),
      asideMin: side(railVisible, 330),
      shellVar: side(railVisible, 330),
      ariaNow: "330",
    });
    // …with no layout render and no store write.
    expect(layoutRenders.count).toBe(rendersBeforeDrag);
    expect(useUIStore.getState().sidebarWidth).toBe(250);

    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 380 }));
    });

    // Release commits once, and React's own render lands on what the drag painted.
    expect(useUIStore.getState().sidebarWidth).toBe(330);
    expect(layoutRenders.count).toBe(rendersBeforeDrag + 1);
    expect(layoutWidths(container)).toEqual(live);
  });

  it("a drag that returns to its starting width leaves the layout where React rendered it", () => {
    const { container, handle } = mountWithSidebar(true);
    const before = layoutWidths(container);

    fireEvent.mouseDown(handle, { clientX: 300 });
    mouseMove(420);
    mouseMove(300);
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300 }));
    });

    expect(useUIStore.getState().sidebarWidth).toBe(250);
    expect(layoutWidths(container)).toEqual(before);
  });

  it("a click on the handle with no movement neither writes the store nor re-renders", () => {
    const { handle } = mountWithSidebar(true);
    const setSidebarWidth = vi.spyOn(useUIStore.getState(), "setSidebarWidth");
    const rendersBeforeClick = layoutRenders.count;

    fireEvent.mouseDown(handle, { clientX: 300 });
    act(() => {
      document.dispatchEvent(new MouseEvent("mouseup", { clientX: 300 }));
    });

    expect(setSidebarWidth).not.toHaveBeenCalled();
    expect(layoutRenders.count).toBe(rendersBeforeClick);
    setSidebarWidth.mockRestore();
  });

  it("window blur mid-drag commits the width the user was looking at", () => {
    const { container, handle } = mountWithSidebar(false);

    fireEvent.mouseDown(handle, { clientX: 300 });
    mouseMove(350);
    act(() => {
      window.dispatchEvent(new Event("blur"));
    });

    expect(useUIStore.getState().sidebarWidth).toBe(300);
    expect(layoutWidths(container).column).toBe("300px");
    // The drag is over: later moves change nothing.
    mouseMove(500);
    expect(layoutWidths(container).column).toBe("300px");
    expect(document.body.style.cursor).toBe("");
  });

  it("hiding the sidebar mid-drag keeps the dragged width and frees the layout", () => {
    const { container, handle } = mountWithSidebar(true);

    fireEvent.mouseDown(handle, { clientX: 300 });
    mouseMove(360);
    act(() => {
      useUIStore.setState({ sidebarVisible: false });
    });

    // The handle unmounted mid-drag: the width is committed, not lost…
    expect(useUIStore.getState().sidebarWidth).toBe(310);
    // …and the shell is sized by React again (rail only), not by the drag.
    const shell = container.querySelector<HTMLElement>(".app-shell");
    const aside = container.querySelector<HTMLElement>(".app-shell__sidebar");
    const railOnly = side(true, 310, false);
    expect(aside?.style.width).toBe(railOnly);
    expect(aside?.style.minWidth).toBe(railOnly);
    expect(shell?.style.getPropertyValue("--shell-side-width")).toBe(railOnly);
    expect(document.body.style.userSelect).toBe("");
  });
});
