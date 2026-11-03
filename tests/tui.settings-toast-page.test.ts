/**
 * The Toast page of the quota window's Settings (`src/tui/window/settings.tsx`): leaving it
 * closes the preview toast. These tests run Solid's browser build, as OpenCode does, so the
 * page's effects run and its props change; the other window tests run the server build, where
 * effects never run.
 */
import { createRoot, createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { SettingsTab } from "../src/tui/display.js";
import { createFileDisplay } from "../src/tui/display.js";
import { createServerSettings } from "../src/tui/server-settings.js";
import { createSettingsEditor } from "../src/tui/window/settings.tsx";
import { createFakeTuiHost, stubJsx } from "./helpers/fake-tui-host.js";
import { THEME } from "./helpers/jsx-tree.js";

vi.mock("solid-js", () => import("../node_modules/solid-js/dist/solid.js"));

/** The Settings editor on a fake host, with the toasts' preview calls counted. */
function startEditor() {
  const tui = createFakeTuiHost({ route: { type: "session", sessionID: "ses_1" }, theme: THEME });
  const display = createFileDisplay(
    createServerSettings({
      settings: async () => ({ values: {}, fromFile: [], providers: [], custom: [] }),
      saveSettings: async () => ({ ok: true, issues: [] }),
    }),
  );
  const toasts = { preview: vi.fn(), closePreview: vi.fn() };
  const settings = createSettingsEditor(tui.context as never, display, toasts);
  return { settings, toasts };
}

/** A window's Settings body on `tab`; `show` shows another page, `dispose` takes it away. */
function drawBody(settings: ReturnType<typeof startEditor>["settings"], tab: SettingsTab) {
  return createRoot((dispose) => {
    const [page, show] = createSignal<SettingsTab>(tab);
    settings.Body({
      get tab() {
        return page();
      },
      showPage: show,
      host: { quota: { snapshot: () => undefined } } as never,
      sessionID: "ses_1",
      box: () => undefined,
      scroll: () => undefined,
      width: 80,
      nowMs: Date.now(),
    });
    return { show, dispose };
  });
}

describe("the Settings window's Toast page", () => {
  beforeEach(() => {
    stubJsx();
  });

  it("shows the preview, and closes it once when the window shows another page", () => {
    const { settings, toasts } = startEditor();
    const body = drawBody(settings, "toast");
    expect(toasts.preview).toHaveBeenCalledWith("ses_1");
    expect(toasts.closePreview).not.toHaveBeenCalled();
    body.show("colors");
    expect(toasts.closePreview).toHaveBeenCalledTimes(1);
    body.dispose();
    expect(toasts.closePreview).toHaveBeenCalledTimes(1);
  });

  it("closes the preview when the window closes on the Toast page", () => {
    const { settings, toasts } = startEditor();
    drawBody(settings, "toast").dispose();
    expect(toasts.closePreview).toHaveBeenCalledTimes(1);
  });

  it("keeps the preview open while a window OpenCode drew again still shows the page", () => {
    const { settings, toasts } = startEditor();
    const old = drawBody(settings, "toast");
    const drawnAgain = drawBody(settings, "toast");
    old.dispose();
    expect(toasts.closePreview).not.toHaveBeenCalled();
    drawnAgain.show("colors");
    expect(toasts.closePreview).toHaveBeenCalledTimes(1);
  });
});
