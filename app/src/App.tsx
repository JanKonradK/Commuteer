import { useState } from "react";
import { load, save } from "./lib/storage";
import { BusView } from "./views/BusView";
import { CommuteView } from "./views/CommuteView";
import { ShuttleView, useShuttles } from "./views/ShuttleView";
import { TrainView } from "./views/TrainView";

const TABS = [
  { id: "commute", icon: "⭐", label: "Commute" },
  { id: "train", icon: "🚆", label: "Trains" },
  { id: "bus", icon: "🚌", label: "Buses" },
  { id: "shuttle", icon: "🚐", label: "Shuttles" },
] as const;
type Tab = (typeof TABS)[number]["id"];

export default function App() {
  const [tab, setTab] = useState<Tab>(() => load("tab", "commute"));
  const [shuttles, setShuttles] = useShuttles();
  const go = (t: Tab) => {
    setTab(t);
    save("tab", t);
  };

  return (
    <main>
      <nav className="tabs" role="tablist">
        {TABS.map((t) => (
          <button
            key={t.id}
            role="tab"
            aria-selected={tab === t.id}
            className={tab === t.id ? "on" : ""}
            onClick={() => go(t.id)}
          >
            <span className="tab-icon">{t.icon}</span>
            <span className="tab-label">{t.label}</span>
          </button>
        ))}
      </nav>
      {tab === "commute" && <CommuteView shuttles={shuttles} />}
      {tab === "train" && <TrainView />}
      {tab === "bus" && <BusView />}
      {tab === "shuttle" && <ShuttleView shuttles={shuttles} onChange={setShuttles} />}
    </main>
  );
}
