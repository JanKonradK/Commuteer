// Where is my bus: a one-line live position, and a map that loads only when opened.

import { useEffect, useRef, useState } from "react";
import type { BusDeparture, BusPack } from "./lib/buses";
import { tripStops, whereBus, whereText } from "./lib/whereBus";
import { Icon } from "./icons";
import { useNow } from "./ui";

const STALE_GPS_S = 180;

export function ageText(s: number): string {
  return s < 60 ? `${Math.max(5, Math.round(s / 5) * 5)} s ago` : `${Math.floor(s / 60)} min ago`;
}

/** "● At Moate · 3 stops away · 20 s ago". Nothing when the bus is not on the road yet. */
export function LiveLine({ pack, d, target, label }: { pack: BusPack; d: BusDeparture; target: "board" | "alight"; label?: string }) {
  const now = useNow();
  if (!d.vehicle) return null;
  const w = whereBus(tripStops(pack, d.tripId), d.vehicle, target === "board" ? d.fromSeq : d.toSeq, now);
  if (!w) return null;
  const old = w.ageS > STALE_GPS_S;
  return (
    <p className={`live-line${old ? " old" : ""}`} aria-live="polite">
      <span className="live-dot" aria-hidden />
      <span>{label && <strong>{label} </strong>}{whereText(w, target)}</span>
      <span className="live-age">{old ? `GPS ${ageText(w.ageS)}` : ageText(w.ageS)}</span>
    </p>
  );
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** The trip on a map: the route, your stops, and the bus. Leaflet is loaded on first use. */
export function BusMap({ pack, d, target }: { pack: BusPack; d: BusDeparture; target: "board" | "alight" }) {
  const box = useRef<HTMLDivElement>(null);
  const map = useRef<import("leaflet").Map | null>(null);
  const bus = useRef<import("leaflet").Marker | null>(null);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const v = d.vehicle;

  // Build the map once per trip.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [L] = await Promise.all([import("leaflet").then((m) => m.default), import("leaflet/dist/leaflet.css")]);
        if (cancelled || !box.current) return;
        const stops = tripStops(pack, d.tripId);
        const m = L.map(box.current, {
          zoomControl: false, attributionControl: true, fadeAnimation: false, dragging: false, touchZoom: true,
          scrollWheelZoom: false, doubleClickZoom: true, boxZoom: false, keyboard: false,
        });
        m.attributionControl.setPrefix(false);
        // Standard OpenStreetMap tiles (no key), darkened in CSS to match the app.
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19, attribution: "© OpenStreetMap contributors",
        }).addTo(m);
        const pts = stops.map((s) => L.latLng(s.lat, s.lon));
        const yours = stops.map((s, i) => (s.seq >= d.fromSeq && s.seq <= d.toSeq ? i : -1)).filter((i) => i >= 0);
        L.polyline(pts, { color: css("--muted"), weight: 3, opacity: 0.6 }).addTo(m);
        if (yours.length > 1) L.polyline(yours.map((i) => pts[i]), { color: css("--accent"), weight: 4 }).addTo(m);
        stops.forEach((s, i) => {
          const end = s.seq === d.fromSeq || s.seq === d.toSeq;
          L.circleMarker(pts[i], {
            radius: end ? 6 : 3, weight: end ? 2.5 : 1.5, color: end ? css("--accent") : css("--muted"),
            fillColor: css("--ground"), fillOpacity: 1,
          }).bindTooltip(s.name, { direction: "top", offset: [0, -6], permanent: end && s.seq === (target === "board" ? d.fromSeq : d.toSeq) }).addTo(m);
        });
        const targetStop = stops.find((s) => s.seq === (target === "board" ? d.fromSeq : d.toSeq));
        const focus = [targetStop && L.latLng(targetStop.lat, targetStop.lon), v && L.latLng(v.lat, v.lon)].filter(Boolean) as import("leaflet").LatLng[];
        if (focus.length === 2) m.fitBounds(L.latLngBounds(focus), { padding: [36, 36], maxZoom: 15 });
        else if (pts.length) m.fitBounds(L.latLngBounds(pts), { padding: [24, 24] });
        map.current = m;
        bus.current = v ? L.marker([v.lat, v.lon], {
          icon: L.divIcon({ className: "bus-marker", html: "<span></span>", iconSize: [18, 18] }),
          zIndexOffset: 1000, keyboard: false,
        }).addTo(m) : null;
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => { cancelled = true; map.current?.remove(); map.current = null; bus.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pack, d.tripId]);

  // Move the bus as new positions arrive.
  useEffect(() => {
    if (v && bus.current) bus.current.setLatLng([v.lat, v.lon]);
  }, [v?.lat, v?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // Full screen: allow panning, and let Leaflet re-measure.
  useEffect(() => {
    const m = map.current;
    if (!m) return;
    if (full) m.dragging.enable(); else m.dragging.disable();
    m.invalidateSize();
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFull(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  if (failed) return null;
  return (
    <div className={`bus-map-wrap${full ? " full" : ""}`}>
      <div ref={box} className="bus-map" role="img" aria-label="Map of the bus route and where the bus is now" />
      <button className="map-toggle" onClick={() => setFull(!full)} aria-label={full ? "Close map" : "Open full-screen map"}>
        <Icon name={full ? "close" : "expand"} size={18} />
      </button>
      {v && bus.current && <button className="map-recenter" onClick={() => map.current?.setView([v.lat, v.lon], Math.max(map.current.getZoom(), 14))}>
        Find bus
      </button>}
    </div>
  );
}
