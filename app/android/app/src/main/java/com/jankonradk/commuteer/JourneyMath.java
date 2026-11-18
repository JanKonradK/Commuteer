package com.jankonradk.commuteer;

import org.json.JSONArray;

/** Pure helpers for the live journey notification, kept free of Android so JUnit can test them. */
final class JourneyMath {
    private JourneyMath() {}

    /**
     * GTFS-Realtime rule, as in the web app's updateAt(): a stop's delay is the latest
     * update at or before it. For the stop itself, an arrival uses its arrival delay.
     * stops: [[sequence, stopId, arrivalDelayS, departureDelayS, skipped], ...]
     * Returns null when the feed has nothing at or before this stop.
     */
    static Integer delayAt(JSONArray stops, int seq, boolean arrival) {
        Integer best = null;
        int bestSeq = Integer.MIN_VALUE;
        for (int i = 0; i < stops.length(); i++) {
            JSONArray s = stops.optJSONArray(i);
            if (s == null || s.isNull(0) || s.optBoolean(4, false)) continue;
            int sSeq = s.optInt(0);
            if (sSeq > seq) continue;
            Integer arr = s.isNull(2) ? null : s.optInt(2);
            Integer dep = s.isNull(3) ? null : s.optInt(3);
            Integer value = sSeq == seq && arrival ? (arr != null ? arr : dep) : (dep != null ? dep : arr);
            if (value != null && sSeq >= bestSeq) {
                best = value;
                bestSeq = sSeq;
            }
        }
        return best;
    }

    /** Straight-line distance in metres. */
    static double distanceM(double lat1, double lon1, double lat2, double lon2) {
        double rad = Math.PI / 180;
        double x = (lon2 - lon1) * rad * Math.cos((lat1 + lat2) * rad / 2);
        double y = (lat2 - lat1) * rad;
        return Math.hypot(x, y) * 6371000;
    }

    /** "in 5 min", "in 1 h 10 min", "now". */
    static String until(long ms) {
        long min = Math.round(ms / 60000.0);
        if (min <= 0) return "now";
        if (min < 60) return "in " + min + " min";
        return "in " + (min / 60) + " h" + (min % 60 != 0 ? " " + (min % 60) + " min" : "");
    }

    /** "On time", "3 min late", "2 min early". */
    static String delayText(int delayS) {
        long m = Math.round(delayS / 60.0);
        if (m == 0) return "on time";
        return m > 0 ? m + " min late" : (-m) + " min early";
    }
}
