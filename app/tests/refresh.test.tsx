import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAutoRefresh } from "../src/ui";

let root: Root;
let host: HTMLDivElement;
let state: ReturnType<typeof useAutoRefresh<string>>;

function Board({ load, route }: { load: () => Promise<string>; route: string }) {
  state = useAutoRefresh(load, [route]);
  return <div>{state.data}</div>;
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

it("ignores an old route's response when stops change", async () => {
  let resolveOld!: (s: string) => void;
  const old = new Promise<string>((resolve) => { resolveOld = resolve; });
  await act(async () => root.render(<Board load={() => old} route="old" />));
  await act(async () => root.render(<Board load={async () => "new route"} route="new" />));
  await act(async () => resolveOld("old route"));
  expect(host.textContent).toBe("new route");
});

it("refreshes immediately when the app becomes visible", async () => {
  const load = vi.fn().mockResolvedValue("live");
  await act(async () => root.render(<Board load={load} route="A" />));
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(load).toHaveBeenCalledTimes(2);
});

it("keeps the last result and shows an error when a refresh fails", async () => {
  const load = vi.fn().mockResolvedValueOnce("live").mockRejectedValueOnce(new Error("Offline"));
  await act(async () => root.render(<Board load={load} route="A" />));
  await act(async () => { await state.refresh(); });
  expect(host.textContent).toBe("live");
  expect(state.error).toBe("Offline");
  expect(state.loading).toBe(false);
});
