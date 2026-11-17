import { useEffect, useState } from "react";
import { BusDetails } from "../BusDetails";
import { JourneyControls } from "../JourneyControls";
import { currentJourney, isChosen, journeyAnchors, localDay, routeKey, saveJourney, type JourneyState } from "../lib/journey";
import { type BusBands, loadBands } from "../lib/busOdds";
import { getForecast, type WeatherHour, weatherAt } from "../lib/weather";
import { WeatherChip, WeatherStrip } from "../Weather";
import { type BusPack, busTimeSource, groupStops, loadPack, packExpired } from "../lib/buses";
import { type Commute, type Connection, commuteStore, planCommute, type Leg, type LegTrip, reverse } from "../lib/commute";
import { clock } from "../lib/predict";
import type { Shuttle } from "../lib/shuttles";
import { Icon } from "../icons";
import { Chip, delayText, delayTone, REFRESH_MS, RefreshButton, RouteBar, Time, Times, UpdatedText, useAutoRefresh, secondsSinceMidnight, useNow } from "../ui";

function spareTone(min: number | null): "good" | "ok" | "bad" {
  if (min === null) return "bad";
  return min >= 5 ? "good" : min >= 2 ? "ok" : "bad";
}

function spareText(min: number | null): string {
  if (min === null) return "No connection";
  const m = Math.floor(min);
  return m <= 0 ? "Just makes it" : `${m} min to spare`;
}

const legName = (t: LegTrip) => (t.kind === "bus" ? `🚌 Bus ${t.label}` : t.kind === "walk" ? "Your current position" : `🚐 ${t.label}`);
const timeSource = (t: LegTrip, end: "departure" | "arrival") => t.userEstimate ? "Your estimate" : t.kind === "shuttle"
  ? "Shuttle timetable"
  : busTimeSource(end === "departure" ? t.busInfo?.departureUpdate : t.busInfo?.arrivalUpdate);
const liveText = (t: LegTrip) => {
  if (t.kind !== "bus") return "";
  const delayMin = t.live ? (t.arriveS - t.scheduledArriveS) / 60 : null;
  const label = delayMin !== null && Math.round(delayMin) === 0 ? "No delay reported" : delayText(delayMin);
  return `${t.busInfo?.arrivalUpdate?.source === "carried" ? "Estimated · " : t.live ? "Stop update · " : ""}${label}`;
};

/** One stop on the timeline: time | dot | place + what happens next. */
function Stop(props: { s: number; scheduledS?: number; place: string; children?: React.ReactNode; last?: boolean }) {
  return (
    <li className={`stop ${props.last ? "last" : ""}`}>
      <Time s={props.s} scheduledS={props.scheduledS} className="mid" />
      <span className="node" aria-hidden />
      <div>
        <div className="place">{props.place}</div>
        {props.children && <div className="what">{props.children}</div>}
      </div>
    </li>
  );
}

const IDLE_REFRESH_MS = 3 * 60_000;
const WEATHER_MS = 30 * 60_000;
/** Seconds since today's midnight (may exceed a day) to epoch milliseconds. */
const msAt = (now: number, s: number) => { const d = new Date(now); d.setHours(0, 0, 0, 0); return d.getTime() + s * 1000; };
const pct = (p: number) => `${Math.round(p * 100)}%`;
const oddsTone = (p: number) => p >= 0.9 ? "good" : p >= 0.7 ? "ok" : "bad";
/** "17:42–17:51": where ~80% of buses really arrive, by measured GPS times. */
const windowText = (r?: [number, number]) => r && Math.round(r[1] / 60) > Math.round(r[0] / 60) ? `${clock(r[0])}–${clock(r[1])}` : null;
const SOON_S = 30 * 60;

export function ConnectionCard(props: {
  c: Connection;
  walkMin: number;
  places: [string, string, string, string];
  open: boolean;
  onToggle: () => void;
  pack: BusPack;
  now: number;
  stale: boolean;
  fastest: boolean;
  chosen?: boolean;
  onChoose?: () => void;
  weather?: WeatherHour[] | null;
}) {
  const { c, places } = props;
  const last = c.second ?? c.first;
  const tone = c.overnight || c.longWait ? "bad" : c.positionUncertain ? "ok" : spareTone(c.spareMin);
  const remaining = c.stage === "first" || c.first.kind === "walk";
  const nowS = secondsSinceMidnight(new Date(props.now));
  const startS = remaining ? nowS : c.first.departS;
  const busChips = [c.first, c.second].filter((t): t is LegTrip => t !== null && t.kind === "bus");
  // You stand outside when you change: weather for the hour you wait for the second leg.
  const waitWeather = props.weather && c.second && c.stage !== "second"
    ? weatherAt(props.weather, msAt(props.now, c.second.departS)) : null;
  const rideLeg = c.stage === "second" ? c.second : c.first;
  const rideName = rideLeg?.kind === "bus" ? `bus ${rideLeg.label}` : rideLeg?.kind === "shuttle" ? "shuttle" : "trip";
  return (
    <li className={`card ${tone}`}>
      <button className="card-head" onClick={props.onToggle} aria-expanded={props.open}>
        <Times
          departS={startS}
          scheduledDepartS={remaining ? nowS : c.first.scheduledDepartS}
          arriveS={last.arriveS}
          scheduledArriveS={last.scheduledArriveS}
          nowS={props.stale || remaining ? undefined : nowS}
          departLabel={remaining ? "Continue from now" : "Leave"}
          arriveLabel={!c.second ? "Transfer only" : c.second.arriveS >= 86400 ? "Arrive · tomorrow" : "Arrive"}
        />
        <div className="chips">
          <Chip tone={tone}>{c.overnight ? "Overnight wait · next day" : c.longWait ? "Long wait" : c.positionUncertain ? "Location update needed" : spareText(c.spareMin)}</Chip>
          {props.chosen && <Chip tone="good">Following</Chip>}
          {c.underway && !props.chosen && rideLeg && <Chip tone="ok">Under way · left {clock(rideLeg.departS)}</Chip>}
          {c.catchChance !== undefined && c.stage !== "second" && !props.stale && (
            <Chip tone={oddsTone(c.catchChance)}>{pct(c.catchChance)} chance you make the change</Chip>
          )}
          {props.fastest && c.second && !c.overnight && !c.longWait && !c.positionUncertain && <Chip tone="none">Earliest arrival</Chip>}
          {busChips.map((t, i) => (
            <Chip key={i} tone={props.stale ? "none" : t.live ? delayTone((t.arriveS - t.scheduledArriveS) / 60) : "none"}>
              Bus {t.label} · {props.stale ? "Last known times" : liveText(t)}
            </Chip>
          ))}
          {waitWeather && <WeatherChip hour={waitWeather} />}
        </div>
        <div className="card-meta">
          {c.second && <span>{Math.max(0, Math.ceil((c.second.arriveS - startS) / 60))} min {remaining ? "remaining" : "total"}</span>}
          {c.second && props.walkMin > 0 && <span>{props.walkMin} min walk</span>}
          <span className={`expand ${props.open ? "open" : ""}`}>{props.open ? "Hide steps" : "Steps"}<Icon name="chevron" size={16} /></span>
        </div>
      </button>
      {c.overnight && <p className="route-warning">This connection is tomorrow. It does not catch tonight’s bus.</p>}
      {c.positionUncertain && <p className="route-warning">The first-leg timetable arrival has passed. The remaining connection is an estimate while phone location updates.</p>}
      {c.changedFrom && <p className="muted small bus-estimate-note" role="status">
        Connection changed after live updates. {c.second ? `Take ${legName(c.second)} at ${clock(c.second.departS)}.` : "No later connection is available."}
      </p>}
      {props.open && <>
        {(c.first.busInfo?.arrivalUpdate?.source === "carried" || c.second?.busInfo?.departureUpdate?.source === "carried") && (
          <p className="muted small bus-estimate-note">Connection uses an estimated bus time. Allow extra time.</p>
        )}
        <ol className="timeline">
          {c.first.kind !== "walk" && <Stop s={c.first.departS} scheduledS={c.first.scheduledDepartS} place={places[0]}>
            Take {legName(c.first)} · {timeSource(c.first, "departure")}
            {windowText(c.first.departRange) && <><br /><span className="muted">80% of buses come {windowText(c.first.departRange)}</span></>}
          </Stop>}
          <Stop s={Math.max(c.first.arriveS, remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.arriveS)}
            scheduledS={c.first.kind === "walk" ? undefined : c.first.scheduledArriveS}
            place={c.first.kind === "walk" ? "Your location" : places[1]}>
            {c.first.kind === "walk" ? "You are here" : `Get off · ${timeSource(c.first, "arrival")}`}<br />
            {windowText(c.first.arriveRange) && <><span className="muted">80% arrive {windowText(c.first.arriveRange)}</span><br /></>}
            {c.stage === "second" ? "Following your chosen second leg" : props.walkMin > 0 ? `🚶 ${props.walkMin} min walk to ${places[2]} · ready at ${clock(Math.max(c.first.arriveS, remaining ? secondsSinceMidnight(new Date(props.now)) : c.first.arriveS) + props.walkMin * 60)}` : "Ready to board here"}
          </Stop>
          {c.second ? (
            <>
              {c.stage !== "second" && <Stop s={c.second.departS} scheduledS={c.second.scheduledDepartS} place={places[2]}>
                Take {legName(c.second)} · {timeSource(c.second, "departure")}<br />
                {windowText(c.second.departRange) && <><span className="muted">80% of buses come {windowText(c.second.departRange)}</span><br /></>}
                <span className={`spare-text ${tone}`}>{c.overnight ? "Tomorrow · overnight wait" : c.longWait ? `${Math.floor((c.spareMin ?? 0) / 60)} h ${Math.floor((c.spareMin ?? 0) % 60)} min wait` : spareText(c.spareMin)}</span>
              </Stop>}
              <Stop s={c.second.arriveS} scheduledS={c.second.scheduledArriveS} place={places[3]} last>
                Arrive · {timeSource(c.second, "arrival")}
                {windowText(c.second.arriveRange) && <><br /><span className="muted">80% arrive {windowText(c.second.arriveRange)}</span></>}
              </Stop>
            </>
          ) : (
            <li className="stop last">
              <span />
              <span className="node" aria-hidden />
              <div className="what">No later connection today</div>
            </li>
          )}
        </ol>
        {c.first.busInfo && <BusDetails d={c.first.busInfo} pack={props.pack} />}
        {c.second?.busInfo && <BusDetails d={c.second.busInfo} pack={props.pack} />}
        {c.catchChance !== undefined && c.stage !== "second" && <p className="muted small">
          The chance of making the change comes from how far TFI bus estimates were from real GPS times.
          It is based on little data so far. Use it as a guide.
        </p>}
        {props.onChoose && c.second && !props.chosen && <button className="primary choose-journey" onClick={props.onChoose}>
          {c.underway ? `I’m on this ${rideName}` : "Follow this journey"}
        </button>}
      </>}
    </li>
  );
}

export function CommuteView({ shuttles, onOpenSettings }: { shuttles: Shuttle[]; onOpenSettings: () => void }) {
  const now = useNow();
  const [pack, setPack] = useState<BusPack | null>(null);
  const [commute, setCommute] = useState<Commute>(commuteStore.get);
  const [journey, setJourney] = useState(() => currentJourney(commute, new Date()));
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [bands, setBands] = useState<BusBands | null>(null);
  const [weather, setWeather] = useState<WeatherHour[] | null>(null);
  useEffect(() => {
    void loadPack().then(setPack);
    void loadBands().then(setBands).catch(() => setBands(null));
  }, []);
  // Forecast for where you wait to change (the rural stop); cached for 30 min.
  const weatherSlot = Math.floor(now / WEATHER_MS);
  const anchors = pack ? journeyAnchors(commute, pack) : [];
  const waitSpot = anchors.find((a) => a.stage === "secondStop") ?? anchors.find((a) => a.stage === "transfer") ?? anchors[0];
  const lat = waitSpot?.latitude, lon = waitSpot?.longitude;
  useEffect(() => {
    if (lat === undefined || lon === undefined) return;
    let live = true;
    getForecast(lat, lon).then((h) => { if (live) setWeather(h); }).catch(() => { if (live) setWeather(null); });
    return () => { live = false; };
  }, [lat, lon, weatherSlot]);
  useEffect(() => {
    if (journey.route !== routeKey(commute) || journey.day !== localDay(new Date(now))) {
      setJourney(currentJourney(commute, new Date(now)));
    }
  }, [commute, journey, now]);
  const updateJourney = (state: JourneyState) => { setJourney(state); saveJourney(state); setOpenKey(null); };
  const update = (c: Commute) => {
    setCommute(c);
    commuteStore.set(c);
    setOpenKey(null);
  };

  // Live times only matter close to departure: refresh every minute when something
  // leaves within 30 min or a journey is being followed, otherwise every 3 min.
  const [refreshMs, setRefreshMs] = useState(REFRESH_MS);
  const { data, at, loading, error, refresh } = useAutoRefresh(
    async () => (pack ? planCommute(commute, pack, shuttles, new Date(), 4, journey, bands ?? undefined) : null),
    [commute, pack, shuttles, journey, bands],
    refreshMs,
  );
  useEffect(() => {
    const nowS = secondsSinceMidnight(new Date(now));
    const next = data?.connections.find((c) => c.stage === "first" || c.first.kind === "walk" || c.first.departS >= nowS);
    const soon = !data || !!journey.chosen || journey.stage !== "start" || !next
      || next.first.kind === "walk" || next.stage === "first" || next.first.departS - nowS <= SOON_S;
    setRefreshMs(soon ? REFRESH_MS : IDLE_REFRESH_MS);
  }, [data, journey, now]);

  if (!pack) return <p className="notice">Loading timetable…</p>;
  const stale = !!error || !!(data && (now - data.fetchedAt > refreshMs + 120_000
    || (data.feedAt && now - data.feedAt > refreshMs + 240_000)));
  const nowS = secondsSinceMidnight(new Date(now));
  const options = data?.connections.filter((c) =>
    (c.stage === "first" || c.first.kind === "walk" || c.first.departS >= nowS) && (c.stage === "second" || !c.second || c.second.departS >= nowS),
  ) ?? [];
  // A trip counts as under way until it arrives, so one you are on never disappears.
  const underway = data?.underway.filter((c) => (c.stage === "second" ? c.second! : c.first).arriveS > nowS - 60) ?? [];
  const groups = groupStops(pack);
  const place = (l: Leg, end: "from" | "to") =>
    l.kind === "bus" ? (groups.find((g) => g.key === l[end])?.name ?? l[end]) : l[end];
  const places: [string, string, string, string] = [
    place(commute.legs[0], "from"),
    place(commute.legs[0], "to"),
    place(commute.legs[1], "from"),
    place(commute.legs[1], "to"),
  ];
  const legText = (l: Leg) => l.kind === "bus" ? "Bus" : (shuttles.find((x) => x.id === l.id)?.name || "Shuttle");
  const via = [legText(commute.legs[0]), commute.walkMin > 0 ? `${commute.walkMin} min walk` : "", legText(commute.legs[1])]
    .filter(Boolean).join(" · ");
  const chosen = journey.chosen;
  const stopFollowing = () => updateJourney({ ...journey, stage: "start", chosen: undefined, first: undefined, second: undefined, originFix: undefined });

  return (
    <section>
      <h1 className="page-title">Commute</h1>
      <RouteBar
        from={
          <button className="route-title" onClick={onOpenSettings} aria-label={`Edit commute: ${places[0]} to ${places[3]}`}>
            <span className="route-name">{places[0]} <span className="muted">→</span> {places[3]}</span>
            <span className="route-via">{via}</span>
          </button>
        }
        onSwap={() => update(reverse(commute))}
        side={<RefreshButton loading={loading} onRefresh={refresh} />}
      />
      <div className="meta">
        <JourneyControls key={routeKey(commute)} commute={commute} pack={pack} shuttles={shuttles}
          state={journey} places={places} onChange={updateJourney} />
        <UpdatedText at={at} loading={loading} stale={!!error} />
      </div>
      {chosen && (
        <div className="following" role="status">
          <span>
            Following {chosen.first.kind === "walk" ? "your journey" : `the ${clock(chosen.first.departS)} journey`}
            {chosen.second && <span className="muted"> · arrive {clock(chosen.second.arriveS)}</span>}
          </span>
          <button onClick={stopFollowing}>Stop</button>
        </div>
      )}
      {chosen && !options.some((c) => isChosen(journey, c)) && !loading && <p className="route-warning" role="status">
        Your chosen connection has changed. Routes recalculate automatically from your phone location.
      </p>}
      {data?.warnings.map((warning) => <p className="route-warning" role="status" key={warning}>{warning}</p>)}
      {stale && <p className="route-warning" role="status">Times may be out of date. Tap refresh before you leave.</p>}
      {packExpired(pack, new Date(now)) && <p className="route-warning">Bus timetable out of date. Route options may be incomplete.</p>}
      {commute.legs.some((l) => l.kind === "shuttle" && !shuttles.some((s) => s.id === l.id)) && (
        <p className="route-warning">
          Add your shuttle timetable to plan the full commute.
          <button className="link" onClick={onOpenSettings}>Open Settings</button>
        </p>
      )}
      {weather && <div className="weather-ahead">
        <p className="section-label">Weather at {waitSpot?.name ?? "your stop"} · dots mark your departures</p>
        <WeatherStrip hours={weather} now={now}
          departures={options.flatMap((c) => c.second && c.stage !== "second" ? [msAt(now, c.second.departS)] : [])} />
      </div>}
      {!chosen && underway.length > 0 && <>
        <p className="section-label">Under way now · tap if you are on board</p>
        <ul>
          {underway.map((c) => {
            const leg = c.stage === "second" ? c.second! : c.first;
            const key = `underway-${c.stage}-${leg.busInfo?.tripId ?? leg.label}-${leg.scheduledDepartS}`;
            return (
              <ConnectionCard key={key} c={c} pack={pack} walkMin={c.stage === "second" ? 0 : data?.walkMin ?? commute.walkMin}
                now={now} stale={stale} fastest={false} weather={weather} places={places}
                open={openKey === key} onToggle={() => setOpenKey(openKey === key ? "" : key)}
                onChoose={() => updateJourney(c.stage === "second"
                  ? { ...journey, chosen: c, stage: "second", second: c.second!, first: undefined, originFix: undefined }
                  : { ...journey, chosen: c, stage: "first", first: c.first, originFix: undefined })} />
            );
          })}
        </ul>
        <p className="section-label">Next departures</p>
      </>}
      {!data && !error && <p className="notice">Working out your routes…</p>}
      {data && options.length === 0 && <p className="notice">No route found for these stops and timetables. Change the stops, or refresh for new times.</p>}
      <ul>
        {options.map((c, i) => {
          const key = `${c.first.busInfo?.tripId ?? c.first.label}-${c.first.scheduledDepartS}`;
          // The next trip is open by default; tap any other to see its steps.
          const open = openKey === null ? i === 0 : openKey === key;
          return (
            <ConnectionCard
              key={key}
              c={c}
              pack={pack}
              walkMin={data?.walkMin ?? commute.walkMin}
              now={now}
              stale={stale}
              fastest={i === 0}
              chosen={isChosen(journey, c)}
              weather={weather}
              onChoose={() => updateJourney({ ...journey, chosen: c, first: c.first, originFix: undefined })}
              places={places}
              open={open}
              onToggle={() => setOpenKey(open ? "" : key)}
            />
          );
        })}
      </ul>
      {options.length > 0 && <p className="footnote">
        Uses the latest bus times, your shuttle timetable and the walk between stops. Times refresh by themselves while the app is open.
      </p>}
    </section>
  );
}
