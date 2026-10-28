// In-app updates from GitHub Releases, modelled on Memoria's updater.
//
// The app asks GitHub for the newest release. On Android, the native AppUpdater
// plugin downloads Commuteer-android.apk, checks it against the release's
// SHA256SUMS.txt and opens Android's installer. Android only accepts it if it's
// signed with the same key as the installed app (see android/app/build.gradle).

import { Capacitor, type PluginListenerHandle, registerPlugin } from "@capacitor/core";

export const APP_VERSION = __APP_VERSION__;
export const REPO = "JanKonradK/Commuteer";
const RELEASES_API = `https://api.github.com/repos/${REPO}/releases?per_page=20`;
export const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;
const APK_ASSET = "Commuteer-android.apk";
const CHECKSUM_ASSET = "SHA256SUMS.txt";
export const CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

const AppUpdater = registerPlugin<{
  install(options: { apkUrl: string; checksumUrl: string; version: string }): Promise<void>;
  addListener(
    event: "progress",
    listener: (progress: { received: number; total: number }) => void,
  ): Promise<PluginListenerHandle>;
}>("AppUpdater");

export interface Release {
  version: string;
  notes: string;
  url: string;
  apkUrl: string | null;
  checksumUrl: string | null;
}

/** Numeric 1.2.3 ordering; a prerelease (1.2.3-beta) sorts below 1.2.3. */
export function compareVersions(left: string, right: string): number {
  const parse = (v: string) => {
    const [core = "", pre = ""] = v.replace(/^v/, "").split("-", 2);
    return { parts: core.split(".").map((p) => Number.parseInt(p, 10) || 0), pre };
  };
  const a = parse(left);
  const b = parse(right);
  for (let i = 0; i < 3; i++) {
    const diff = (a.parts[i] ?? 0) - (b.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  return a.pre < b.pre ? -1 : 1;
}

/** The release notes above the "## Download" table the release workflow appends. */
export function releaseNotes(body: string): string {
  return body.split(/^##\s+Downloads?\b/im)[0]?.trim() ?? "";
}

export function parseReleases(body: unknown): Release[] {
  const list = Array.isArray(body) ? (body as Record<string, unknown>[]) : [];
  return list
    .filter((r) => !r.draft && !r.prerelease && String(r.tag_name ?? "").replace(/^v/, ""))
    .map((r) => {
      const assets = Array.isArray(r.assets) ? (r.assets as Record<string, unknown>[]) : [];
      const asset = (name: string) => {
        const found = assets.find((a) => a.name === name);
        return found ? String(found.browser_download_url) : null;
      };
      return {
        version: String(r.tag_name).replace(/^v/, ""),
        notes: releaseNotes(String(r.body ?? "")),
        url: String(r.html_url ?? RELEASES_PAGE),
        apkUrl: asset(APK_ASSET),
        checksumUrl: asset(CHECKSUM_ASSET),
      };
    })
    .sort((a, b) => compareVersions(b.version, a.version));
}

/** The newest release if it's newer than this copy, otherwise null. */
export async function checkForUpdate(): Promise<Release | null> {
  const res = await fetch(RELEASES_API, { headers: { accept: "application/vnd.github+json" } });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub limits update checks. Try again in an hour.");
  if (!res.ok) throw new Error(`GitHub responded ${res.status}. Try again later.`);
  const latest = parseReleases(await res.json())[0];
  return latest && compareVersions(latest.version, APP_VERSION) > 0 ? latest : null;
}

/** Android: download, verify and open the installer. Elsewhere: open the release page. */
export async function installUpdate(release: Release, onProgress: (fraction: number | null) => void): Promise<void> {
  if (!Capacitor.isNativePlatform()) {
    window.open(release.url, "_blank", "noopener");
    return;
  }
  if (!release.apkUrl || !release.checksumUrl) throw new Error(`Version ${release.version} has no Android download.`);
  const listener = await AppUpdater.addListener("progress", ({ received, total }) =>
    onProgress(total > 0 ? Math.min(1, received / total) : null),
  );
  try {
    await AppUpdater.install({ apkUrl: release.apkUrl, checksumUrl: release.checksumUrl, version: release.version });
  } finally {
    await listener.remove();
  }
}
