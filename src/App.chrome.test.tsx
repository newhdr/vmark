/**
 * App composition root — the platform→chrome wiring (#1296).
 *
 * Every PART of this decision was already tested — `usesOverlayTitleBar()`,
 * `shellChromeVars()`, and AppShell's "reserve only when filled" — and none of
 * them could see the one line that connects them. Inverting the ternary in
 * App.tsx passed the entire suite: macOS would lose its title bar and
 * Windows/Linux would get the empty strip back, with every test still green.
 *
 * So this renders MainLayout through the REAL AppShell and asserts what the
 * window shows: the app's title bar in the chrome slot, the space the primary
 * column holds for it, and the CSS variables the shell root publishes. The
 * platform is the lever (`usesOverlayTitleBar`). The feature subtrees stubbed
 * below are separate features with their own suites; the shell, the editor
 * area and the title bar are this file's subject and run for real.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { SHELL_TOP_INSET, SHELL_CARD_INSET, SHELL_CARD_RADIUS } from "@/shell/shellChrome";
import { CHROME_HEIGHT } from "@/shell/AppShell";

const platform = vi.hoisted(() => ({ overlayTitleBar: true, boom: false }));
vi.mock("@/utils/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/platform")>()),
  usesOverlayTitleBar: () => {
    // A lever for making the layout throw, so the root error boundary has a
    // failure to catch (audit finding 9 — it had never been exercised).
    if (platform.boom) throw new Error("layout exploded");
    return platform.overlayTitleBar;
  },
}));

const appError = vi.hoisted(() => vi.fn());
vi.mock("@/utils/debug", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  appError: (...args: unknown[]) => appError(...args),
}));

// The feature subtrees App.tsx composes are stubbed, and deliberately so: this
// file tests the COMPOSITION, and every one of these has its own suite. Loading
// them for real also has a measurable cost — importing App.tsx pulled 12
// otherwise-unloaded modules into the coverage report (~80 uncovered functions
// in code no test exercises), which moved the global percentages without a line
// of production code becoming less tested.
vi.mock("@/components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/BottomBar/BottomBar", () => ({ BottomBar: () => null }));
vi.mock("@/components/CoherenceOverlays", () => ({ CoherenceOverlays: () => null }));
vi.mock("@/components/GeniePicker/GeniePickerOverlay", () => ({ GeniePickerOverlay: () => null }));
vi.mock("@/components/KnowledgeBasePanel/KnowledgeBaseOverlay", () => ({
  KnowledgeBaseOverlay: () => null,
}));
vi.mock("@/components/WindowStatusPanel/WindowStatusOverlay", () => ({
  WindowStatusOverlay: () => null,
}));

// Lifecycle hooks run real effects (Tauri listeners, workspace restore); the
// composition they belong to is not what this file is about.
vi.mock("@/hooks/lifecycle", () => ({
  useWorkspaceLifecycle: () => {},
  useEditorLifecycle: () => {},
  DocumentWindowMount: () => null,
  MainWindowRunners: () => null,
}));
vi.mock("@/hooks/useTheme", () => ({ useTheme: () => {}, FOCUS_DIM_OPACITY: {} }));
vi.mock("@/components/Terminal/useTerminalPosition", () => ({ useTerminalPosition: () => {} }));
vi.mock("@/hooks/useTabModeSync", () => ({ useTabModeSync: () => {} }));
vi.mock("@/hooks/useWindowStatus", () => ({ useWindowStatus: () => {} }));
vi.mock("@/contexts/WindowContext", () => ({
  WindowProvider: ({ children }: { children: unknown }) => children,
  useIsDocumentWindow: () => true,
  useWindowLabel: () => "main",
}));

const AppModule = await import("./App");
const { MainLayout } = AppModule;
const App = AppModule.default;
const { useTabStore } = await import("@/stores/tabStore");
const { useSettingsStore } = await import("@/stores/settingsStore");
const { useUIStore } = await import("@/stores/uiStore");
const settingsAtStart = useSettingsStore.getState();
const uiAtStart = useUIStore.getState();

beforeEach(() => {
  platform.overlayTitleBar = true;
  platform.boom = false;
  appError.mockReset();
  useTabStore.setState({ tabs: {}, activeTabId: {}, untitledCounter: 0 });
  useSettingsStore.setState(settingsAtStart, true);
  useUIStore.setState(uiAtStart, true);
});

/** What one render of the layout put on screen, scoped to its own container. */
function rendered(container: HTMLElement) {
  const shell = container.querySelector<HTMLElement>(".app-shell");
  if (!shell) throw new Error("the layout rendered no .app-shell root");
  const primary = shell.querySelector<HTMLElement>(":scope > .app-shell__primary");
  if (!primary) throw new Error("the shell rendered no primary column");
  return {
    shell,
    /** The app's own title bar, or null where the window shows none. */
    titleBar: within(container).queryByRole("banner", { name: "Application title bar" }),
    /** The space the primary column holds above itself for the chrome strip. */
    chromeSpace: primary.style.paddingTop,
    cssVar: (name: string) => shell.style.getPropertyValue(name),
  };
}

describe("MainLayout — chrome is mounted only where the app overlays the title bar", () => {
  it("mounts the app's title bar in the chrome slot on macOS, and holds its space", () => {
    const view = rendered(render(<MainLayout />).container);
    expect(view.titleBar).not.toBeNull();
    // In the chrome slot itself — a direct child of the shell root — not
    // somewhere inside a feature subtree.
    expect(view.titleBar?.parentElement).toBe(view.shell);
    expect(view.chromeSpace).toBe(`${CHROME_HEIGHT}px`);
  });

  it("fills the chrome slot with the BROWSER-AWARE title bar", async () => {
    // What separates the app's title bar from a plain one: in a browser
    // workspace it carries the webpage tabs. Swapping the slot's occupant for
    // anything else loses them, so that swap has to be a deliberate edit.
    // The browser workspace observes its viewport's size; jsdom has no
    // ResizeObserver, and setup.ts leaves it to the tests that need one.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    useTabStore.getState().createBrowserTab("main", "https://one.example", "One");
    const view = rendered(render(<MainLayout />).container);
    if (!view.titleBar) throw new Error("no title bar in the chrome slot");
    const titleBar = within(view.titleBar);
    expect(titleBar.getByRole("tablist", { name: "Webpages" })).toBeInTheDocument();
    expect(titleBar.getByRole("textbox", { name: "Address bar" })).toHaveValue("https://one.example/");
    // The page's native view is created asynchronously; once it exists the
    // title bar's omnibox stops loading and offers Reload instead of Stop.
    expect(await titleBar.findByRole("button", { name: "Reload" })).toBeInTheDocument();
  });

  it("mounts NO title bar off macOS, and holds no space for one", () => {
    platform.overlayTitleBar = false;
    const view = rendered(render(<MainLayout />).container);
    expect(view.titleBar).toBeNull();
    // The empty band above the editor that #1296 reported.
    expect(view.chromeSpace).toBe("0px");
  });

  it("reserves the shell top inset on macOS", () => {
    const view = rendered(render(<MainLayout />).container);
    // Read from the constant, not restated: shellChrome.test.ts owns the
    // derivation, this owns only that the shell root publishes it.
    expect(view.cssVar("--shell-top-inset")).toBe(`${SHELL_TOP_INSET}px`);
  });

  it("reserves no shell top inset off macOS", () => {
    platform.overlayTitleBar = false;
    const view = rendered(render(<MainLayout />).container);
    expect(view.cssVar("--shell-top-inset")).toBe("0px");
  });

  // The sidebar style setting reaches the shell root. shellChrome.test.ts owns
  // what each style publishes; this owns that App passes the SETTING, not a
  // constant — hardcoding either style here would pass every unit test.
  it("publishes the flat frame by default and the card when chosen", () => {
    const flat = rendered(render(<MainLayout />).container);
    expect(flat.cssVar("--shell-card-inset")).toBe("0px");
    expect(flat.cssVar("--shell-card-radius")).toBe("0px");
    expect(flat.cssVar("--shell-card-shadow")).toBe("none");

    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, sidebarStyle: "card" } }));
    const card = rendered(render(<MainLayout />).container);
    expect(card.cssVar("--shell-card-inset")).toBe(`${SHELL_CARD_INSET}px`);
    expect(card.cssVar("--shell-card-radius")).toBe(`${SHELL_CARD_RADIUS}px`);
  });

  it("sizes the leading column with the gutters only in card mode", () => {
    useUIStore.setState({ sidebarVisible: true, sidebarWidth: 260 });
    const aside = (c: HTMLElement) => c.querySelector<HTMLElement>(".app-shell__sidebar")?.style.width;
    expect(aside(render(<MainLayout />).container)).toBe("260px");

    useSettingsStore.setState((s) => ({ appearance: { ...s.appearance, sidebarStyle: "card" } }));
    expect(aside(render(<MainLayout />).container)).toBe(`${260 + SHELL_CARD_INSET * 2}px`);
  });

  it("publishes the rail width on both platforms", () => {
    expect(rendered(render(<MainLayout />).container).cssVar("--workspace-rail-width")).toBe("30px");
    platform.overlayTitleBar = false;
    expect(rendered(render(<MainLayout />).container).cssVar("--workspace-rail-width")).toBe("30px");
  });

  // The route table is the only thing between the app's entry point and the
  // layout under test; without this the wiring above is proven for a component
  // nothing is shown to reach.
  it("is what the app's own '/' route renders", () => {
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    expect(rendered(container).titleBar).not.toBeNull();
  });

  it("keeps the chrome slot and the inset on the SAME side of the decision", () => {
    // The failure this guards is a half-applied change: chrome dropped but the
    // inset left in place would put an unexplained gap above a window that has
    // no title bar of its own.
    for (const overlay of [true, false]) {
      platform.overlayTitleBar = overlay;
      const view = rendered(render(<MainLayout />).container);
      const hasChrome = view.titleBar !== null;
      const reservesInset = view.cssVar("--shell-top-inset") !== "0px";
      expect(hasChrome).toBe(reservesInset);
    }
  });
});

// Audit finding 9 — the root boundary had never been exercised. This does not
// give it a recovery path (still a one-way latch, and that is a product
// decision), but it pins that a render failure is caught and reported rather
// than taking the window down with a blank screen.
describe("App — the root error boundary", () => {
  it("renders the fallback instead of propagating a render failure", () => {
    platform.boom = true;
    const { container } = render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    // The layout never composed; the boundary took over.
    expect(container.querySelector(".app-shell")).toBeNull();
    expect(document.body.textContent).toContain("layout exploded");
  });

  it("reports the failure rather than swallowing it", () => {
    platform.boom = true;
    render(
      <MemoryRouter initialEntries={["/"]}>
        <App />
      </MemoryRouter>
    );
    expect(appError).toHaveBeenCalled();
  });
});

// The drop overlay is defined in App.tsx itself, so it is part of this file's
// composition rather than a feature import — and it had no test at all.
describe("App — the file-drop overlay", () => {
  it("stays out of the way until files are being dragged", async () => {
    const { useUIStore } = await import("@/stores/uiStore");
    useUIStore.setState({ isDraggingFiles: false });
    render(<MainLayout />);
    expect(screen.queryByText("Drop to open")).not.toBeInTheDocument();
  });

  it("appears while files are being dragged over the window", async () => {
    const { useUIStore } = await import("@/stores/uiStore");
    useUIStore.setState({ isDraggingFiles: true });
    render(<MainLayout />);
    expect(screen.getByText("Drop to open")).toBeInTheDocument();
    // Still mounted: the reset re-renders the overlay, so it belongs in act.
    act(() => useUIStore.setState({ isDraggingFiles: false }));
  });
});

// WI-UI1.6 — the toaster follows the theme instead of sonner's light default.
// Sonner is mocked (it does not mount its container under jsdom); the subject
// is App's THEME PROP wiring, which is exactly what the mock captures.
vi.mock("sonner", () => ({
  Toaster: (props: { theme?: string }) => <div data-testid="toaster-probe" data-theme={props.theme} />,
  toast: Object.assign(() => "id", {
    success: () => "id",
    error: () => "id",
    warning: () => "id",
    info: () => "id",
    dismiss: () => {},
  }),
}));

describe("App — the Toaster theme prop follows isDark", () => {
  it.each([
    [true, "dark"],
    [false, "light"],
  ] as const)("isDark=%s renders a %s toaster", async (dark, expected) => {
    const { useSettingsStore } = await import("@/stores/settingsStore");
    useSettingsStore.getState().updateAppearanceSetting("followSystemAppearance", false);
    useSettingsStore.getState().updateAppearanceSetting("theme", dark ? "night" : "paper");
    const { default: App } = await import("./App");
    const { unmount } = render(
      <MemoryRouter>
        <App />
      </MemoryRouter>,
    );
    expect(screen.getByTestId("toaster-probe").getAttribute("data-theme")).toBe(expected);
    unmount();
  });
});
