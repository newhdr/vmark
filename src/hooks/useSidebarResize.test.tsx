/**
 * Tests for useSidebarResize.
 *
 * Covers width clamping, the live paint during a drag and the single store
 * commit when it ends (WI-RA9B.5), listener cleanup on mouseup/blur/unmount,
 * and body style restoration. Regression here leaks mousemove listeners,
 * traps the cursor in `col-resize`, or re-renders the layout per pointer move.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";

const { mockSetSidebarWidth, uiState } = vi.hoisted(() => ({
  mockSetSidebarWidth: vi.fn(),
  uiState: { sidebarWidth: 250 },
}));

vi.mock("@/stores/uiStore", () => ({
  SIDEBAR_MIN_WIDTH: 220,
  SIDEBAR_MAX_WIDTH: 480,
  useUIStore: {
    getState: () => ({
      sidebarWidth: uiState.sidebarWidth,
      setSidebarWidth: mockSetSidebarWidth,
    }),
  },
}));

import { useSidebarResize } from "./useSidebarResize";

/** A detached copy of the layout the handle lives in: shell > aside > column > handle. */
function buildLayout(sidebarWidth: number, asideWidth: number) {
  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.style.setProperty("--shell-side-width", `${asideWidth}px`);
  const aside = document.createElement("aside");
  aside.className = "app-shell__sidebar";
  aside.style.width = `${asideWidth}px`;
  aside.style.minWidth = `${asideWidth}px`;
  const column = document.createElement("div");
  column.className = "app-sidebar-stack__sidebar";
  column.style.width = `${sidebarWidth}px`;
  const handle = document.createElement("div");
  handle.setAttribute("aria-valuenow", String(sidebarWidth));
  column.appendChild(handle);
  aside.appendChild(column);
  shell.appendChild(aside);
  return { shell, aside, column, handle };
}

let layout: ReturnType<typeof buildLayout>;

function fireMouseDown(clientX: number, handle: HTMLElement = layout.handle): React.MouseEvent<HTMLElement> {
  // The handler reads `preventDefault`, `clientX` and `currentTarget`. A real
  // React synthetic event isn't reachable from a hook test without rendering
  // the handle; App.sidebarDrag.test.tsx covers that path end to end.
  return {
    preventDefault: vi.fn(),
    clientX,
    currentTarget: handle,
  } as unknown as React.MouseEvent<HTMLElement>;
}

function fireMouseMove(clientX: number): void {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX }));
}

function fireMouseUp(): void {
  document.dispatchEvent(new MouseEvent("mouseup"));
}

function fireBlur(): void {
  window.dispatchEvent(new Event("blur"));
}

beforeEach(() => {
  mockSetSidebarWidth.mockReset();
  // The store keeps what it is given, so a second drag starts from the first one's commit.
  mockSetSidebarWidth.mockImplementation((width: number) => {
    uiState.sidebarWidth = width;
  });
  uiState.sidebarWidth = 250;
  window.innerWidth = 1024;
  document.body.style.cursor = "";
  document.body.style.userSelect = "";
  // The aside is 46px wider than the sidebar column: rail (30) + card gutters (16).
  layout = buildLayout(250, 296);
});

describe("useSidebarResize", () => {
  it.each([
    ["below the floor clamps to MIN (220)", 500, 100, 220],
    ["above the ceiling clamps to MAX (480)", 0, 1000, 480],
    ["inside the range passes through", 100, 150, 300],
  ])("a drag %s and commits once, on release", (_name, downX, moveX, expected) => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(downX)));
    act(() => fireMouseMove(moveX));

    // Nothing is written while the pointer is down…
    expect(mockSetSidebarWidth).not.toHaveBeenCalled();
    // …but the layout already shows the width.
    expect(layout.column.style.width).toBe(`${expected}px`);

    act(() => fireMouseUp());
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarWidth).toHaveBeenCalledWith(expected);
  });

  it("paints the live width on the column, the shell aside, the shell variable and the handle", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(100)));
    act(() => fireMouseMove(150));

    expect(layout.column.style.width).toBe("300px");
    expect(layout.aside.style.width).toBe("346px");
    expect(layout.aside.style.minWidth).toBe("346px");
    expect(layout.shell.style.getPropertyValue("--shell-side-width")).toBe("346px");
    expect(layout.handle.getAttribute("aria-valuenow")).toBe("300");
    act(() => fireMouseUp());
  });

  it("clamps against a narrow window, keeping room for the editor", () => {
    window.innerWidth = 700; // 700 - 480 leaves 220 for the sidebar
    const { result } = renderHook(() => useSidebarResize());
    mockSetSidebarWidth.mockClear(); // the mount-time reclamp is not under test here
    uiState.sidebarWidth = 200;
    act(() => result.current.handleResizeStart(fireMouseDown(0)));
    act(() => fireMouseMove(400));
    act(() => fireMouseUp());

    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarWidth).toHaveBeenCalledWith(220);
  });

  it("still commits when the handle is outside the expected layout", () => {
    const orphan = document.createElement("div");
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(100, orphan)));
    act(() => fireMouseMove(150));
    act(() => fireMouseUp());

    expect(orphan.getAttribute("aria-valuenow")).toBe("300");
    expect(mockSetSidebarWidth).toHaveBeenCalledWith(300);
  });

  it("a press with no movement commits nothing", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(100)));
    act(() => fireMouseUp());

    expect(mockSetSidebarWidth).not.toHaveBeenCalled();
    expect(layout.column.style.width).toBe("250px");
  });

  it("sets body cursor and userSelect on drag start", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(0)));

    expect(document.body.style.cursor).toBe("col-resize");
    expect(document.body.style.userSelect).toBe("none");

    act(() => fireMouseUp());
  });

  it("resets body styles and removes listeners on mouseup", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(0)));
    act(() => fireMouseMove(50));
    act(() => fireMouseUp());

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");

    // Further mousemove/mouseup must neither repaint nor write.
    act(() => fireMouseMove(200));
    act(() => fireMouseUp());
    expect(layout.column.style.width).toBe("300px");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
  });

  it("window blur ends the drag and commits the width on screen", () => {
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(0)));
    act(() => fireMouseMove(40));
    act(() => fireBlur());

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarWidth).toHaveBeenCalledWith(290);

    act(() => fireMouseMove(500));
    expect(layout.column.style.width).toBe("290px");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
  });

  it("a second mousedown before mouseup does not leak the previous drag's listeners", () => {
    // A mouseup delivered outside the window never reaches the document, so
    // the next press arrives with the previous drag still attached. A leaked
    // mousemove handler would keep painting from the FIRST drag's origin.
    const { result } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(100)));
    act(() => fireMouseMove(130)); // first drag: 250 → 280
    act(() => result.current.handleResizeStart(fireMouseDown(130)));

    // The interrupted drag was committed before the new one read its start.
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(280);

    act(() => fireMouseMove(150)); // second drag: 280 → 300
    expect(layout.column.style.width).toBe("300px");

    act(() => fireMouseUp());
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(2);
    expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(300);

    // And mouseup fully cleaned up: nothing after release.
    act(() => fireMouseMove(400));
    act(() => fireMouseUp());
    expect(layout.column.style.width).toBe("300px");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(2);
  });

  it("unmount mid-drag cleans up and keeps the dragged width", () => {
    const { result, unmount } = renderHook(() => useSidebarResize());
    act(() => result.current.handleResizeStart(fireMouseDown(0)));
    act(() => fireMouseMove(30));

    unmount();

    expect(document.body.style.cursor).toBe("");
    expect(document.body.style.userSelect).toBe("");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarWidth).toHaveBeenCalledWith(280);

    act(() => fireMouseMove(500));
    act(() => fireMouseUp());
    expect(layout.column.style.width).toBe("280px");
    expect(mockSetSidebarWidth).toHaveBeenCalledTimes(1);
  });

  // ─── WI-2.2 — keyboard resize (a11y) ──────────────────────────────────
  //
  // Verifies the arrow-key resize handler clamps to MIN/MAX, supports the
  // Shift modifier for larger steps, and routes Home/End to MIN/MAX. The
  // hook reads the current width from the mocked uiStore on each call —
  // tests adjust `uiState.sidebarWidth` between presses to simulate a
  // sequence (since the mock is a getter, not a true reactive store).

  function fireKeyDown(
    key: string,
    opts: { shiftKey?: boolean } = {},
  ): React.KeyboardEvent {
    return {
      key,
      shiftKey: !!opts.shiftKey,
      preventDefault: vi.fn(),
    } as unknown as React.KeyboardEvent;
  }

  describe("handleResizeKeyDown (a11y)", () => {
    it("ArrowRight increments width by KEYBOARD_RESIZE_STEP (8)", () => {
      uiState.sidebarWidth = 250;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("ArrowRight")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(258);
    });

    it("ArrowLeft decrements width by KEYBOARD_RESIZE_STEP (8)", () => {
      uiState.sidebarWidth = 250;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("ArrowLeft")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(242);
    });

    it("Shift+ArrowRight uses LARGE step (32)", () => {
      uiState.sidebarWidth = 250;
      const { result } = renderHook(() => useSidebarResize());

      act(() =>
        result.current.handleResizeKeyDown(
          fireKeyDown("ArrowRight", { shiftKey: true }),
        ),
      );

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(282);
    });

    it("ArrowLeft clamps to MIN (220) when already at floor", () => {
      uiState.sidebarWidth = 152;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("ArrowLeft")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(220);
    });

    it("ArrowRight clamps to MAX (480) when already at ceiling", () => {
      uiState.sidebarWidth = 495;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("ArrowRight")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(480);
    });

    it("Home jumps directly to MIN (220)", () => {
      uiState.sidebarWidth = 350;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("Home")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(220);
    });

    it("End jumps directly to MAX (480)", () => {
      uiState.sidebarWidth = 350;
      const { result } = renderHook(() => useSidebarResize());

      act(() => result.current.handleResizeKeyDown(fireKeyDown("End")));

      expect(mockSetSidebarWidth).toHaveBeenLastCalledWith(480);
    });

    it("ignores non-resize keys (no store write, no preventDefault)", () => {
      uiState.sidebarWidth = 250;
      const { result } = renderHook(() => useSidebarResize());
      const evt = fireKeyDown("Tab");

      act(() => result.current.handleResizeKeyDown(evt));

      expect(mockSetSidebarWidth).not.toHaveBeenCalled();
      expect(evt.preventDefault).not.toHaveBeenCalled();
    });

    it("calls preventDefault on resize keys to prevent default scroll behavior", () => {
      uiState.sidebarWidth = 250;
      const { result } = renderHook(() => useSidebarResize());
      const evt = fireKeyDown("ArrowRight");

      act(() => result.current.handleResizeKeyDown(evt));

      expect(evt.preventDefault).toHaveBeenCalledTimes(1);
    });
  });
});
