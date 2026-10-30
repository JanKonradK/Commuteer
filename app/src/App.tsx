import { useState } from "react";
import { Icon, type IconName } from "./icons";
import { load, save } from "./lib/storage";
import { CommuteView } from "./views/CommuteView";
import { SettingsView } from "./views/SettingsView";
import { useShuttles } from "./views/ShuttleView";
import { MODES, TimetablesView } from "./views/TimetablesView";
import { UpdateBanner, useUpdates } from "./UpdateBanner";

const TABS = [
  { id: "commute", icon: "commute", label: "Commute" },
  { id: "timetables", icon: "timetable", label: "Timetables" },
  { id: "settings", icon: "settings", label: "Settings" },
] as const satisfies readonly { id: string; icon: IconName; label: string }[];
type Tab = (typeof TABS)[number]["id"];

/** The last open tab. Older versions had a tab per transport type: open that timetable instead. */
function initialTab(): Tab {
  const saved = load<string>("tab", "commute");
  const tab = TABS.find((t) => t.id === saved);
  if (tab) return tab.id;
  if (MODES.some((m) => m.id === saved)) {
    save("timetableMode", saved);
    return "timetables";
  }
  return "commute";
}

export default function App() {
  const [tab, setTab] = useState<Tab>(initialTab);
  const [shuttles, setShuttles] = useShuttles();
  const updates = useUpdates();
  const go = (t: Tab) => {
    setTab(t);
    save("tab", t);
    window.scrollTo(0, 0);
  };
  const openSettings = () => go("settings");

  return (
    <>
      <main>
        <UpdateBanner updates={updates} />
        {tab === "commute" && <CommuteView shuttles={shuttles} onOpenSettings={openSettings} />}
        {tab === "timetables" && <TimetablesView shuttles={shuttles} onOpenSettings={openSettings} />}
        {tab === "settings" && <SettingsView shuttles={shuttles} onShuttlesChange={setShuttles} updates={updates} />}
      </main>
      {/* Floating bar near the thumb. Content scrolls underneath it. */}
      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => go(t.id)}>
            <Icon name={t.icon} size={22} />
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
    </>
  );
}
