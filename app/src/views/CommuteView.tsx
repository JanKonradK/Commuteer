import { useEffect, useState } from "react";
import { JourneyControls } from "../JourneyControls";
import { currentJourney, isChosen, journeyAnchors, localDay, routeKey, saveJourney, type JourneyState } from "../lib/journey";
import { type BusBands, loadBands } from "../lib/busOdds";
import { getForecast, type WeatherHour, weatherAt } from "../lib/weather";
import { WeatherChip, WeatherStrip } from "../Weather";
import { BusMap, LiveLine } from "../LiveBus";
import { journeyJson, liveSupported, startLive, stopLive } from "../lib/liveJourney";
import { type BusPack, groupStops, loadPack, packExpired } from "../lib/buses";
import { type Commute, type Connection, commuteStore, planCommute, type Leg, type LegTrip, reverse } from "../lib/commute";
import { clock } from "../lib/predict";
import type { Shuttle } from "../lib/shuttles";
import { Icon, type IconName } from "../icons";
import { Chip, delayTone, LIVE_REFRESH_MS, RefreshButton, RouteBar, Time, Times, UpdatedText, useAutoRefresh, secondsSinceMidnight, useNow } from "../ui";

function spareTone(min: number | null): "good" | "ok" | "bad" {
  if (min === null) return "bad";
  return min >= 5 ? "good" : min >= 2 ? "ok" : "bad";
}

/** "12 min spare", "1 h 5 min wait", "Just makes it". */
function spareText(c: Connection): string {
  if (c.overnight) return "Tomorrow";
  const min = c.spareMin;
  if (min === null) return "No connection";
  const m = Math.floor(min);
  if (c.longWait) return `${Math.floor(m / 60)} h ${m % 60} min wait`;
  return m <= 0 ? "Just makes it" : `${m} min spare`;
}

const legIcon = (t: LegTrip): IconName => (t.kind === "bus" ? "bus" : t.kind === "shuttle" ? "shuttle" : "walk");
/** The shortest name that still identifies the ride: "466", "Center Parcs". */
const legLabel = (t: LegTrip) => (t.kind === "shuttle" ? t.label.replace(/\s*shuttle$/i, "") : t.label);

/** An icon and a name: what you ride, and optionally when it leaves (amber or red when late). */
function Ride({ t, time }: { t: LegTrip; time?: boolean }) {
  const late = t.live ? delayTone((t.departS - t.scheduledDepartS) / 60) : "none";
  return (
    <span className="ride">
      <Icon name={legIcon(t)} size={16} />
      <span>{legLabel(t)}</span>
      {time && <span className={`ride-time ${late}${t.live ? " live" : ""}`}><Time s={t.departS} scheduledS={t.scheduledDepartS} /></span>}
    </span>
  );
}

/** One stop on the timeline: time | dot | place, and what you take from there. */
function Stop(props: { s: number; range?: [number, number]; live?: boolean; place: string; children?: React.ReactNode; last?: boolean }) {
  const r = props.range && Math.round(props.range[1] / 60) > Math.round(props.range[0] / 60) ? props.range : null;
  return (
    <li className={`stop ${props.last ? "last" : ""}`}>
      {/* A green dot marks a time from live GPS/feed data; plain times are the timetable. */}
      <span className={`stop-time${props.live ? " live" : ""}`}>
        <Time s={props.s} className="mid" />
        {/* Where ~80% of buses really are, from GPS history. */}
        {r && <span className="range" title="80% of buses, from real GPS times">{clock(r[0])}–{clock(r[1])}</span>}
      </span>
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
  // A trip already moving shows when it left; one you are on counts from now.
  const riding = c.underway ? (c.stage === "second" ? c.second : c.first) : null;
  const waitWeather = props.weather && c.second && c.stage !== "second"
    ? weatherAt(props.weather, msAt(props.now, c.second.departS)) : null;
  const rideLeg = c.stage === "second" ? c.second : c.first;
  const rideName = rideLeg?.kind === "bus" ? `bus ${rideLeg.label}` : rideLeg?.kind === "shuttle" ? "shuttle" : "trip";
  const liveLegs = ([c.first, c.second] as const).flatMap((t, i) => {
    if (!t || t.kind !== "bus" || !t.busInfo?.vehicle || (i === 0 && c.stage === "second")) return [];
    const ridingThis = (i === 0 && c.stage === "first") || (i === 1 && c.stage === "second");
    return [{ t, d: t.busInfo, target: ridingThis ? "alight" as const : "board" as const }];
  });
  const showFirst = c.first.kind !== "walk" && c.stage !== "second";
  return (
    <li className={`card ${tone}${props.fastest ? " hero" : ""}${props.open ? " open" : ""}${c.underway ? " moving" : ""}${props.chosen ? " chosen" : ""}`}>
      <button className="card-head" onClick={props.onToggle} aria-expanded={props.open}>
        <Times
          departS={riding ? riding.departS : remaining ? nowS : c.first.departS}
          scheduledDepartS={riding ? riding.scheduledDepartS : remaining ? nowS : c.first.scheduledDepartS}
          arriveS={last.arriveS}
          scheduledArriveS={last.scheduledArriveS}
          nowS={props.stale || remaining || riding ? undefined : nowS}
          departLabel={riding ? "Left" : remaining ? "Now" : undefined}
          arriveLabel={c.second && c.second.arriveS >= 86400 ? "Tomorrow" : undefined}
        />
        <div className="legs">
          {showFirst && <Ride t={c.first} />}
          {showFirst && c.second && <span className="legs-arrow" aria-hidden>›</span>}
          {c.second && <Ride t={c.second} time={c.stage !== "second"} />}
        </div>
        {liveLegs.map((l) => (
          <LiveLine key={l.d.tripId} pack={props.pack} d={l.d} target={l.target} label={liveLegs.length > 1 ? l.t.label : undefined} />
        ))}
        {(c.stage !== "second" || c.changedFrom) && <div className="chips">
          {c.stage !== "second" && <Chip tone={tone}>{c.positionUncertain ? "Estimate" : spareText(c)}</Chip>}
          {c.catchChance !== undefined && c.stage !== "second" && !props.stale && (
            <span className={`chip ${oddsTone(c.catchChance)}`} title="Chance you make the change">{pct(c.catchChance)}</span>
          )}
          {waitWeather && <WeatherChip hour={waitWeather} />}
          {c.changedFrom && <Chip tone="ok">Changed</Chip>}
        </div>}
        <span className={`expand ${props.open ? "open" : ""}`}><Icon name="chevron" size={16} /></span>
      </button>
      {props.open && <>
        <ol className="timeline">
          {showFirst && <Stop s={c.first.departS} range={c.first.departRange} live={c.first.live} place={places[0]}>
            <Ride t={c.first} />
          </Stop>}
          {c.stage === "second" && c.second ? (
            <Stop s={c.second.departS} live={c.second.live} place={places[2]}><Ride t={c.second} /></Stop>
          ) : (
            <Stop s={Math.max(c.first.arriveS, remaining ? nowS : c.first.arriveS)}
              range={c.first.arriveRange} live={c.first.kind !== "walk" && c.first.live} place={c.first.kind === "walk" ? "You" : places[1]}>
              {props.walkMin > 0 && c.second && <span className="ride"><Icon name="walk" size={16} />{props.walkMin} min</span>}
            </Stop>
          )}
          {c.second && c.stage !== "second" && (
            <Stop s={c.second.departS} range={c.second.departRange} live={c.second.live} place={places[2]}>
              <Ride t={c.second} />
            </Stop>
          )}
          {c.second && <Stop s={c.second.arriveS} range={c.second.arriveRange} live={c.second.live} place={places[3]} last />}
        </ol>
        {liveLegs[0] && <BusMap pack={props.pack} d={liveLegs[0].d} target={liveLegs[0].target} />}
        {props.onChoose && c.second && !props.chosen && <button className="primary choose-journey" onClick={props.onChoose}>
          <Icon name="bell" size={18} />{c.underway ? `I’m on this ${rideName}` : "Follow"}
        </button>}
      </>}
    </li>
  );
}

/** Stop names for: first leg from, first leg to, second leg from, second leg to. */
function placesOf(commute: Commute, pack: BusPack): [string, string, string, string] {
  const groups = groupStops(pack);
  const place = (l: Leg, end: "from" | "to") =>
    l.kind === "bus" ? (groups.find((g) => g.key === l[end])?.name ?? l[end]) : l[end];
  return [place(commute.legs[0], "from"), place(commute.legs[0], "to"), place(commute.legs[1], "from"), place(commute.legs[1], "to")];
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

  // Live times only matter close to departure: refresh every 30 s when something
  // leaves within 30 min, a bus is under way or a journey is being followed; otherwise every 3 min.
  const [refreshMs, setRefreshMs] = useState(LIVE_REFRESH_MS);
  const { data, at, loading, error, refresh } = useAutoRefresh(
    async () => (pack ? planCommute(commute, pack, shuttles, new Date(), 4, journey, bands ?? undefined) : null),
    [commute, pack, shuttles, journey, bands],
    refreshMs,
  );
  useEffect(() => {
    const nowS = secondsSinceMidnight(new Date(now));
    const next = data?.connections.find((c) => c.stage === "first" || c.first.kind === "walk" || c.first.departS >= nowS);
    const soon = !data || !!journey.chosen || data.underway.length > 0 || journey.stage !== "start" || !next
      || next.first.kind === "walk" || next.stage === "first" || next.first.departS - nowS <= SOON_S;
    setRefreshMs(soon ? LIVE_REFRESH_MS : IDLE_REFRESH_MS);
  }, [data, journey, now]);

  // Following a journey keeps a live notification going on Android, updated with each refresh.
  const [notify, setNotify] = useState<boolean | null>(null);
  const liveConnection = journey.chosen && data
    ? [...data.connections, ...data.underway].find((c) => isChosen(journey, c)) ?? journey.chosen : journey.chosen;
  const liveJson = liveConnection && pack
    ? journeyJson(liveConnection, placesOf(commute, pack), pack, data?.walkMin ?? commute.walkMin, now) : null;
  useEffect(() => {
    if (!liveSupported()) return;
    if (liveJson) void startLive(liveJson).then((ok) => { if (ok !== null) setNotify(ok); });
    else { void stopLive(); setNotify(null); }
  }, [liveJson]);

  if (!pack) return <p className="notice">Loading timetable…</p>;
  const stale = !!error || !!(data && (now - data.fetchedAt > refreshMs + 120_000
    || (data.feedAt && now - data.feedAt > refreshMs + 240_000)));
  const nowS = secondsSinceMidnight(new Date(now));
  const options = data?.connections.filter((c) =>
    (c.stage === "first" || c.first.kind === "walk" || c.first.departS >= nowS) && (c.stage === "second" || !c.second || c.second.departS >= nowS),
  ) ?? [];
  // A trip counts as under way until it arrives, so one you are on never disappears.
  const underway = data?.underway.filter((c) => (c.stage === "second" ? c.second! : c.first).arriveS > nowS - 60) ?? [];
  const places = placesOf(commute, pack);
  const chosen = journey.chosen;
  const stopFollowing = () => updateJourney({ ...journey, stage: "start", chosen: undefined, first: undefined, second: undefined, originFix: undefined });

  const card = (c: Connection, key: string, hero: boolean) => {
    const open = openKey === key;
    return (
      <ConnectionCard key={key} c={c} pack={pack} walkMin={data?.walkMin ?? commute.walkMin} now={now} stale={stale}
        fastest={hero} chosen={isChosen(journey, c)} weather={weather} places={places} open={open}
        onToggle={() => setOpenKey(open ? null : key)}
        onChoose={() => updateJourney({ ...journey, chosen: c, first: c.first, originFix: undefined })} />
    );
  };
  const keyOf = (c: Connection) => `${c.first.busInfo?.tripId ?? c.first.label}-${c.first.scheduledDepartS}`;
  const [next, ...later] = options;

  return (
    <section className="commute">
      <h1 className="sr-only">Commute</h1>
      <RouteBar
        from={
          <button className="route-title" onClick={onOpenSettings} aria-label={`From ${places[0]}, edit commute`}>
            <span className="route-name">{places[0]}</span>
          </button>
        }
        to={
          <button className="route-title" onClick={onOpenSettings} aria-label={`To ${places[3]}, edit commute`}>
            <span className="route-name">{places[3]}</span>
          </button>
        }
        onSwap={() => update(reverse(commute))}
        side={<RefreshButton loading={loading} onRefresh={refresh} />}
      />
      {/* Location and freshness only speak up when something is wrong. */}
      <JourneyControls key={routeKey(commute)} commute={commute} pack={pack} shuttles={shuttles}
        state={journey} places={places} onChange={updateJourney} />
      {stale && <p className="route-warning" role="status"><UpdatedText at={at} loading={false} stale /></p>}
      {data?.warnings.map((warning) => <p className="route-warning" role="status" key={warning}>{warning}</p>)}
      {packExpired(pack, new Date(now)) && <p className="route-warning">Bus timetable out of date</p>}
      {commute.legs.some((l) => l.kind === "shuttle" && !shuttles.some((s) => s.id === l.id)) && (
        <p className="route-warning">
          No shuttle timetable
          <button className="link" onClick={onOpenSettings}>Add</button>
        </p>
      )}
      {chosen && (
        <div className="following" role="status">
          <Icon name="bell" size={16} />
          <span>{notify === false ? "Notifications are off in Android settings" : "Following"}</span>
          <button onClick={stopFollowing}>Stop</button>
        </div>
      )}
      {!chosen && underway.length > 0 && <ul className="group">
        {underway.map((c) => {
          const leg = c.stage === "second" ? c.second! : c.first;
          const key = `underway-${c.stage}-${leg.busInfo?.tripId ?? leg.label}-${leg.scheduledDepartS}`;
          return (
            <ConnectionCard key={key} c={c} pack={pack} walkMin={c.stage === "second" ? 0 : data?.walkMin ?? commute.walkMin}
              now={now} stale={stale} fastest={false} weather={weather} places={places}
              open={openKey === key} onToggle={() => setOpenKey(openKey === key ? null : key)}
              onChoose={() => updateJourney(c.stage === "second"
                ? { ...journey, chosen: c, stage: "second", second: c.second!, first: undefined, originFix: undefined }
                : { ...journey, chosen: c, stage: "first", first: c.first, originFix: undefined })} />
          );
        })}
      </ul>}
      {!data && !error && <p className="notice">Loading…</p>}
      {data && options.length === 0 && <p className="notice">No route found</p>}
      {options.length > 0 && <ul className="group">
        {next && card(next, keyOf(next), true)}
        {later.map((c) => card(c, keyOf(c), false))}
      </ul>}
      {weather && <div className="weather-ahead" aria-label={`Weather at ${waitSpot?.name ?? "the change"}`}>
        <WeatherStrip hours={weather} now={now}
          trips={options.flatMap((c) => c.second && c.stage !== "second" && !c.overnight
            ? [{ leaveMs: msAt(now, c.first.kind === "walk" ? nowS : c.first.departS), waitMs: msAt(now, c.second.departS) }] : [])} />
      </div>}
    </section>
  );
}
