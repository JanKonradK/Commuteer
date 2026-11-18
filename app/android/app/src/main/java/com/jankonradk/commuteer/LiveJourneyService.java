package com.jankonradk.commuteer;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Keeps a followed journey up to date while the app is closed: an ongoing notification with a
 * ticking countdown, refreshed from the live bus API every 30 s, plus one-off alerts for "time to
 * leave", a connection at risk, a cancelled bus and "your stop is next".
 */
public class LiveJourneyService extends Service {
    static final String EXTRA_JOURNEY = "journey";
    static final String ACTION_STOP = "com.jankonradk.commuteer.STOP_LIVE";
    private static final String CHANNEL_LIVE = "live_journey";
    private static final String CHANNEL_ALERT = "journey_alerts";
    private static final int ID_LIVE = 4101;
    private static final long TICK_MS = 30_000;
    private static final long STALE_MS = 5 * 60_000;
    private static final long IDLE_TICK_MS = 5 * 60_000;
    private static final long SOON_MS = 30 * 60_000;
    private static final long MAX_RUN_MS = 8 * 3600_000L;
    private static final String DOT = " · ";

    /** One leg of the journey, with its live estimate. */
    private static final class Leg {
        String label, tripId, serviceDate, toName;
        int fromSeq, toSeq;
        long departMs, arriveMs; // scheduled
        long estDepartMs, estArriveMs; // scheduled + live delay
        Integer delayS; // live delay at the arrival stop, null if unknown
        boolean canceled, live;
        double toLat = Double.NaN, toLon = Double.NaN;
        double busLat = Double.NaN, busLon = Double.NaN;
        long busT;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Set<String> alerted = new HashSet<>();
    private volatile List<Leg> legs = new ArrayList<>();
    private String apiUrl;
    private int walkMin, leadMin;
    private long startedAt;
    private volatile long fetchedAt;
    private PowerManager.WakeLock wakeLock;
    private final Runnable tick = this::tick;

    static volatile boolean running;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            load(new JSONObject(intent.getStringExtra(EXTRA_JOURNEY)));
        } catch (Exception e) {
            stopSelf();
            return START_NOT_STICKY;
        }
        channels();
        Notification n = build();
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(ID_LIVE, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        } else {
            startForeground(ID_LIVE, n);
        }
        running = true;
        if (wakeLock == null) {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "commuteer:live");
            wakeLock.setReferenceCounted(false);
        }
        wakeLock.acquire(MAX_RUN_MS);
        startedAt = System.currentTimeMillis();
        handler.removeCallbacks(tick);
        handler.post(tick);
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        running = false;
        handler.removeCallbacks(tick);
        io.shutdownNow();
        if (wakeLock != null && wakeLock.isHeld()) wakeLock.release();
        super.onDestroy();
    }

    private void load(JSONObject j) throws Exception {
        apiUrl = j.getString("api");
        walkMin = j.optInt("walkMin", 0);
        leadMin = j.optInt("leadMin", 5);
        List<Leg> out = new ArrayList<>();
        JSONArray a = j.getJSONArray("legs");
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.getJSONObject(i);
            Leg l = new Leg();
            l.label = o.getString("label");
            l.tripId = o.isNull("tripId") ? null : o.optString("tripId", null);
            l.serviceDate = o.isNull("serviceDate") ? null : o.optString("serviceDate", null);
            l.fromSeq = o.optInt("fromSeq");
            l.toSeq = o.optInt("toSeq");
            l.toName = o.optString("toName", "");
            l.departMs = o.getLong("departMs");
            l.arriveMs = o.getLong("arriveMs");
            l.estDepartMs = o.optLong("estDepartMs", l.departMs);
            l.estArriveMs = o.optLong("estArriveMs", l.arriveMs);
            l.live = o.optBoolean("live", false);
            if (o.has("delayS") && !o.isNull("delayS")) l.delayS = o.getInt("delayS");
            if (o.has("toLat") && !o.isNull("toLat")) {
                l.toLat = o.getDouble("toLat");
                l.toLon = o.getDouble("toLon");
            }
            out.add(l);
        }
        if (out.isEmpty()) throw new IllegalArgumentException("no legs");
        legs = out;
    }

    private void tick() {
        long now = System.currentTimeMillis();
        Leg last = legs.get(legs.size() - 1);
        if (now > last.estArriveMs + 5 * 60_000 || now - startedAt > MAX_RUN_MS) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
            return;
        }
        boolean anyBus = false;
        for (Leg l : legs) anyBus |= l.tripId != null;
        if (anyBus && !io.isShutdown()) {
            io.execute(() -> {
                fetch();
                handler.post(this::update);
            });
        } else {
            update();
        }
        // Far from leaving, live times barely matter: check every 5 min to save battery.
        boolean soon = legs.get(0).estDepartMs - now <= SOON_MS;
        handler.postDelayed(tick, soon ? TICK_MS : IDLE_TICK_MS);
    }

    /** Pull live delays and positions for the bus legs. Runs off the main thread. */
    private void fetch() {
        try {
            StringBuilder ids = new StringBuilder();
            for (Leg l : legs) {
                if (l.tripId == null) continue;
                if (ids.length() > 0) ids.append(',');
                ids.append(URLEncoder.encode(l.tripId, "UTF-8"));
            }
            HttpURLConnection c = (HttpURLConnection) new URL(apiUrl + "?trips=" + ids).openConnection();
            c.setConnectTimeout(8000);
            c.setReadTimeout(8000);
            if (c.getResponseCode() != 200) return;
            ByteArrayOutputStream buf = new ByteArrayOutputStream();
            try (InputStream in = c.getInputStream()) {
                byte[] b = new byte[8192];
                for (int n; (n = in.read(b)) > 0; ) buf.write(b, 0, n);
            }
            JSONObject body = new JSONObject(buf.toString(StandardCharsets.UTF_8.name()));
            long feedMs = body.optLong("feed_timestamp") * 1000;
            if (System.currentTimeMillis() - feedMs > STALE_MS) return;
            JSONObject trips = body.optJSONObject("trips");
            JSONObject vehicles = body.optJSONObject("vehicles");
            for (Leg l : legs) {
                if (l.tripId == null) continue;
                JSONObject t = trips == null ? null : trips.optJSONObject(l.tripId);
                if (t != null && (l.serviceDate == null || l.serviceDate.equals(t.optString("date")))) {
                    JSONArray stops = t.optJSONArray("stops");
                    Integer dep = stops == null ? null : JourneyMath.delayAt(stops, l.fromSeq, false);
                    Integer arr = stops == null ? null : JourneyMath.delayAt(stops, l.toSeq, true);
                    l.canceled = t.optBoolean("canceled");
                    l.live = dep != null || arr != null;
                    if (dep != null) l.estDepartMs = l.departMs + dep * 1000L;
                    if (arr != null) l.estArriveMs = l.arriveMs + arr * 1000L;
                    l.delayS = arr != null ? arr : dep;
                }
                JSONObject v = vehicles == null ? null : vehicles.optJSONObject(l.tripId);
                if (v != null) {
                    l.busLat = v.optDouble("lat");
                    l.busLon = v.optDouble("lon");
                    l.busT = v.optLong("t") * 1000;
                }
            }
            fetchedAt = System.currentTimeMillis();
        } catch (Exception ignored) {
            // No signal: keep the last estimate; the notification says so after a minute.
        }
    }

    private void update() {
        alerts(System.currentTimeMillis());
        try {
            NotificationManagerCompat.from(this).notify(ID_LIVE, build());
        } catch (SecurityException ignored) {
            // Notifications are off; the service still ends on time.
        }
    }

    /** Even = waiting for leg phase/2, odd = on it, legs*2 = arrived. */
    private int phase(long now) {
        for (int i = 0; i < legs.size(); i++) {
            Leg l = legs.get(i);
            if (now < l.estDepartMs) return i * 2;
            if (now < l.estArriveMs) return i * 2 + 1;
        }
        return legs.size() * 2;
    }

    private static String hm(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.UK).format(new Date(ms));
    }

    private static String status(Leg l) {
        if (l.canceled) return "cancelled";
        if (l.delayS != null && l.live) return JourneyMath.delayText(l.delayS);
        return "timetable time";
    }

    /** Minutes between arriving from leg i and leg i+1 leaving, after the walk. */
    private long spareMin(int i) {
        Leg a = legs.get(i), b = legs.get(i + 1);
        return Math.floorDiv(b.estDepartMs - a.estArriveMs - walkMin * 60_000L, 60_000L);
    }

    private Notification build() {
        long now = System.currentTimeMillis();
        int p = phase(now);
        int i = Math.min(p / 2, legs.size() - 1);
        Leg l = legs.get(i);
        Leg last = legs.get(legs.size() - 1);
        boolean onBoard = p % 2 == 1;
        String title;
        long target;
        StringBuilder text = new StringBuilder();
        if (p >= legs.size() * 2) {
            title = "Arrived at " + last.toName;
            target = last.estArriveMs;
        } else if (onBoard) {
            title = "On " + l.label + DOT + l.toName + " " + hm(l.estArriveMs);
            target = l.estArriveMs;
            text.append(capital(status(l)));
        } else {
            title = (i == 0 ? "Leave " + JourneyMath.until(l.estDepartMs - now) + DOT + l.label
                : l.label + " " + JourneyMath.until(l.estDepartMs - now)) + " " + hm(l.estDepartMs);
            target = l.estDepartMs;
            text.append(capital(status(l)));
        }
        if (p < legs.size() * 2 && i + 1 < legs.size()) {
            Leg n = legs.get(i + 1);
            text.append(DOT).append("then ").append(n.label).append(' ').append(hm(n.estDepartMs))
                .append(", ").append(spareText(spareMin(i)));
        }
        if (p < legs.size() * 2) text.append(DOT).append("arrive ").append(hm(last.estArriveMs));
        if (fetchedAt > 0 && legs.get(0).estDepartMs - now <= SOON_MS && now - fetchedAt > 2 * TICK_MS + 10_000) text.append(DOT).append("no live data");

        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Intent stop = new Intent(this, LiveJourneyService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_LIVE)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(text.toString())
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text.toString()))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setCategory(NotificationCompat.CATEGORY_NAVIGATION)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setContentIntent(tap)
            .addAction(0, "Stop updates", stopPi)
            .setShowWhen(true)
            .setWhen(target)
            .setUsesChronometer(target > now)
            .setColor(0xFFE08CFF);
        if (target > now) b.setChronometerCountDown(true);
        return b.build();
    }

    private static String spareText(long min) {
        if (min < 0) return "missed by " + (-min) + " min";
        return min == 0 ? "just makes it" : min + " min to spare";
    }

    private static String capital(String s) {
        return s.isEmpty() ? s : Character.toUpperCase(s.charAt(0)) + s.substring(1);
    }

    /** One-off alerts. Each fires once per journey (keyed), so nothing repeats every 30 s. */
    private void alerts(long now) {
        Leg first = legs.get(0);
        Leg last = legs.get(legs.size() - 1);
        long toLeave = first.estDepartMs - now;
        if (toLeave <= leadMin * 60_000L && toLeave > -60_000) {
            alert("leave", "Leave " + JourneyMath.until(toLeave),
                first.label + " " + hm(first.estDepartMs) + DOT + status(first) + DOT + "arrive " + hm(last.estArriveMs));
        }
        for (int i = 0; i < legs.size(); i++) {
            Leg l = legs.get(i);
            if (l.canceled && now < l.estDepartMs) {
                alert("cancel" + i, l.label + " " + hm(l.departMs) + " is cancelled", "Open Commuteer for the next option.");
            }
            if (i + 1 < legs.size() && now < legs.get(i + 1).estDepartMs && spareMin(i) < 2) {
                Leg n = legs.get(i + 1);
                long spare = spareMin(i);
                alert("tight" + i, spare < 0 ? "You may miss " + n.label : "Tight change for " + n.label,
                    n.label + " leaves " + hm(n.estDepartMs) + DOT + spareText(spare) + ". Open Commuteer for options.");
            }
            // On board and close to your stop: get ready.
            boolean onBoard = now >= l.estDepartMs && now < l.estArriveMs + 120_000;
            if (onBoard && !Double.isNaN(l.toLat) && !Double.isNaN(l.busLat) && now - l.busT < 120_000
                && JourneyMath.distanceM(l.busLat, l.busLon, l.toLat, l.toLon) < 1200) {
                alert("stop" + i, l.toName + " is next", "Get ready to get off " + l.label + ".");
            }
        }
    }

    private void alert(String key, String title, String text) {
        if (!alerted.add(key)) return;
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = PendingIntent.getActivity(this, 2, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        Notification n = new NotificationCompat.Builder(this, CHANNEL_ALERT)
            .setSmallIcon(R.drawable.ic_stat_bus)
            .setContentTitle(title)
            .setContentText(text)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(text))
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setAutoCancel(true)
            .setContentIntent(tap)
            .setColor(0xFFE08CFF)
            .build();
        try {
            NotificationManagerCompat.from(this).notify(key.hashCode(), n);
        } catch (SecurityException ignored) {
            // Notifications are off.
        }
    }

    private void channels() {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        NotificationChannel live = new NotificationChannel(CHANNEL_LIVE, "Live journey", NotificationManager.IMPORTANCE_LOW);
        live.setDescription("Countdown and live bus times for the journey you follow.");
        live.setShowBadge(false);
        NotificationChannel alerts = new NotificationChannel(CHANNEL_ALERT, "Journey alerts", NotificationManager.IMPORTANCE_HIGH);
        alerts.setDescription("Time to leave, tight connections, cancellations and your stop.");
        nm.createNotificationChannel(live);
        nm.createNotificationChannel(alerts);
    }
}
