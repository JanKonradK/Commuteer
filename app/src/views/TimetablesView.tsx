import { useState } from "react";
import { Icon, type IconName } from "../icons";
import type { Shuttle } from "../lib/shuttles";
import { load, save } from "../lib/storage";
import { BusView } from "./BusView";
import { ShuttleView } from "./ShuttleView";
import { TrainView } from "./TrainView";

// New kinds of timetable (flights, ferries…) get a button here, not a new tab.
export const MODES = [
  { id: "train", icon: "train", label: "Trains" },
  { id: "bus", icon: "bus", label: "Buses" },
  { id: "shuttle", icon: "shuttle", label: "Shuttles" },
] as const satisfies readonly { id: string; icon: IconName; label: string }[];
export type Mode = (typeof MODES)[number]["id"];

export function TimetablesView(props: { shuttles: Shuttle[]; onOpenSettings: () => void }) {
  const [mode, setMode] = useState<Mode>(() => {
    const m = load<string>("timetableMode", "train");
    return MODES.find((x) => x.id === m)?.id ?? "train";
  });
  const pick = (m: Mode) => {
    setMode(m);
    save("timetableMode", m);
  };
  return (
    <section>
      <h1 className="page-title">Timetables</h1>
      <div className="segmented" role="tablist" aria-label="Timetable">
        {MODES.map((m) => (
          <button key={m.id} role="tab" aria-selected={mode === m.id} className={mode === m.id ? "on" : ""} onClick={() => pick(m.id)}>
            <Icon name={m.icon} size={18} />
            {m.label}
          </button>
        ))}
      </div>
      {mode === "train" && <TrainView />}
      {mode === "bus" && <BusView />}
      {mode === "shuttle" && <ShuttleView shuttles={props.shuttles} onOpenSettings={props.onOpenSettings} />}
    </section>
  );
}
