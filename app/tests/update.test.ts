import { APP_VERSION, compareVersions, parseReleases, releaseNotes } from "../src/lib/update";

describe("updates", () => {
  it("knows its own version", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("orders versions numerically, with prereleases first", () => {
    expect(compareVersions("0.10.0", "0.9.9")).toBe(1);
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(-1);
    expect(compareVersions("0.2.0", "0.2.1")).toBe(-1);
  });

  it("keeps only the notes above the download table", () => {
    expect(releaseNotes("Buses now show live delays.\n\n## Download\n| table |")).toBe(
      "Buses now show live delays.",
    );
  });

  it("reads GitHub releases, newest first, skipping drafts and prereleases", () => {
    const apk = (v: string) => ({
      name: "Commuteer-android.apk",
      browser_download_url: `https://github.com/JanKonradK/Commuteer/releases/download/v${v}/Commuteer-android.apk`,
    });
    const releases = parseReleases([
      { tag_name: "v0.2.0", body: "Old", html_url: "u1", assets: [apk("0.2.0")] },
      { tag_name: "v0.4.0", body: "Draft", draft: true, assets: [] },
      { tag_name: "v0.3.0-beta", body: "Beta", prerelease: true, assets: [] },
      { tag_name: "v0.3.0", body: "New\n## Download\nx", html_url: "u2", assets: [apk("0.3.0")] },
    ]);
    expect(releases.map((r) => r.version)).toEqual(["0.3.0", "0.2.0"]);
    expect(releases[0]).toMatchObject({ notes: "New", url: "u2", checksumUrl: null });
    expect(releases[0].apkUrl).toContain("/v0.3.0/Commuteer-android.apk");
  });
});
