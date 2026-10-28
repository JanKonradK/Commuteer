import { useCallback, useEffect, useState } from "react";
import { APP_VERSION, CHECK_INTERVAL_MS, checkForUpdate, installUpdate, type Release } from "./lib/update";

type State =
  | { kind: "idle" | "checking" | "current" }
  | { kind: "available"; release: Release }
  | { kind: "downloading"; release: Release; progress: number | null }
  | { kind: "error"; message: string; release?: Release };

/** Checks GitHub on launch and twice a day; shows a banner when there's a newer version. */
export function useUpdates() {
  const [state, setState] = useState<State>({ kind: "idle" });

  const check = useCallback(async (quiet: boolean) => {
    setState((s) => (s.kind === "downloading" ? s : { kind: "checking" }));
    try {
      const release = await checkForUpdate();
      setState(release ? { kind: "available", release } : { kind: "current" });
    } catch (e) {
      // Automatic checks fail silently (no signal, GitHub busy); manual ones explain.
      setState(quiet ? { kind: "idle" } : { kind: "error", message: e instanceof Error ? e.message : "Check failed" });
    }
  }, []);

  useEffect(() => {
    if (import.meta.env.DEV) return; // leave GitHub's hourly limit to installed copies
    void check(true);
    const timer = setInterval(() => void check(true), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [check]);

  const install = useCallback(async (release: Release) => {
    setState({ kind: "downloading", release, progress: null });
    try {
      await installUpdate(release, (progress) => setState({ kind: "downloading", release, progress }));
      setState({ kind: "available", release }); // Android's installer takes over from here
    } catch (e) {
      setState({ kind: "error", release, message: e instanceof Error ? e.message : "Download failed. Try again." });
    }
  }, []);

  return { state, check: () => check(false), install };
}

export function UpdateBanner({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { state, install } = updates;
  if (state.kind === "available" || (state.kind === "error" && state.release)) {
    const release = state.release as Release;
    return (
      <div className="update">
        <div>
          <strong>Version {release.version} is available</strong>
          {state.kind === "error" ? (
            <div className="update-error">{state.message}</div>
          ) : (
            release.notes && <div className="update-notes">{release.notes.split("\n")[0]}</div>
          )}
        </div>
        <button className="primary" onClick={() => void install(release)}>
          Install
        </button>
      </div>
    );
  }
  if (state.kind === "downloading") {
    const pct = state.progress === null ? null : Math.round(state.progress * 100);
    return (
      <div className="update">
        <strong>Downloading {state.release.version}…{pct !== null && ` ${pct}%`}</strong>
        <div className="update-bar">
          <span style={{ width: `${pct ?? 15}%` }} />
        </div>
      </div>
    );
  }
  return null;
}

/** Version line with a manual check, shown at the bottom of the app. */
export function VersionLine({ updates }: { updates: ReturnType<typeof useUpdates> }) {
  const { state, check } = updates;
  const status =
    state.kind === "checking"
      ? "Checking…"
      : state.kind === "current"
        ? "Up to date"
        : state.kind === "error" && !state.release
          ? state.message
          : "";
  return (
    <footer className="version">
      <span>Commuteer {APP_VERSION}</span>
      {status && <span> · {status}</span>}
      <button className="link" onClick={() => void check()} disabled={state.kind === "checking"}>
        Check for updates
      </button>
    </footer>
  );
}
