/**
 * The Files header's buttons fit the narrowest sidebar, measured in a real engine.
 *
 * The header is a toggle, the view title and five action buttons in one row,
 * and the leading column clips what overflows it. With the floor below the
 * row's width, dragging the sidebar narrow cut New File and New Folder off the
 * right edge. jsdom has no layout, so only a real engine can show the row fits.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import "@/styles/index.css";
import "@/styles/icon-button-shared.css";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_MIN_WIDTH, useUIStore } from "@/stores/uiStore";
import { Sidebar } from "./Sidebar";

// The real FileExplorer mounts in the files view; its boundaries answer with an
// empty workspace (as in Sidebar.test.tsx).
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn((command: string) =>
    Promise.resolve(
      command === "list_directory_tree"
        ? { rootPrefix: "/workspace/", separator: "/", entries: [], truncated: false }
        : undefined,
    ),
  ),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  getCurrentWebviewWindow: () => ({
    label: "main",
    listen: vi.fn(() => Promise.resolve(() => {})),
    onFocusChanged: vi.fn(() => Promise.resolve(() => {})),
    onDragDropEvent: vi.fn(() => Promise.resolve(() => {})),
  }),
}));
vi.mock("@/contexts/WindowContext", () => ({
  useWindowLabel: () => "main",
  useIsDocumentWindow: () => true,
}));
vi.mock("@/hooks/useDocumentState", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/useDocumentState")>()),
  useDocumentFilePath: () => null,
}));

// The flat sidebar's divider is drawn inside the column (app-shell.css), so the
// sidebar itself gets one pixel less than the stored width.
const DIVIDER = 1;

let root: Root | null = null;
let host: HTMLElement | null = null;

/** Mounts at `width`, waiting out the first render's translation load. */
async function mount(width: number) {
  useUIStore.setState({ sidebarVisible: true, sidebarViewMode: "files" });
  host = document.createElement("div");
  host.style.cssText = `width: ${width - DIVIDER}px; height: 600px; display: flex; overflow: hidden`;
  document.body.append(host);
  root = createRoot(host);
  flushSync(() => root!.render(<Sidebar />));
  await vi.waitFor(() => {
    if (!document.querySelector(".sidebar-header")) throw new Error("the sidebar has not rendered");
  });
}

afterEach(() => {
  root?.unmount();
  host?.remove();
  root = null;
  host = null;
});

function headerButtons(): DOMRect[] {
  const buttons = document.querySelectorAll<HTMLElement>(".sidebar-header button");
  return Array.from(buttons, (button) => button.getBoundingClientRect());
}

describe("sidebar header fit (real engine, production Sidebar)", () => {
  it.each([SIDEBAR_MIN_WIDTH, SIDEBAR_DEFAULT_WIDTH])("every Files button is inside a %dpx sidebar", async (width) => {
    await mount(width);
    const edge = host!.getBoundingClientRect().right;
    const buttons = headerButtons();
    expect(buttons).toHaveLength(6);
    for (const button of buttons) {
      expect(button.width).toBeGreaterThan(0);
      expect(button.right).toBeLessThanOrEqual(edge + 0.5);
    }
  });

  it("the title gives way before the buttons do", async () => {
    await mount(SIDEBAR_MIN_WIDTH);
    const title = document.querySelector<HTMLElement>(".sidebar-title")!;
    expect(title.scrollWidth).toBeGreaterThan(title.clientWidth);
    expect(getComputedStyle(title).textOverflow).toBe("ellipsis");
  });
});
