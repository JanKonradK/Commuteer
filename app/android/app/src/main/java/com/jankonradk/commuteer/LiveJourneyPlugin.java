package com.jankonradk.commuteer;

import android.Manifest;
import android.content.Intent;
import android.os.Build;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/** Starts and stops the live journey notification (LiveJourneyService). */
@CapacitorPlugin(
    name = "LiveJourney",
    permissions = { @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = "notifications") }
)
public class LiveJourneyPlugin extends Plugin {

    /** start({ journey: "<json>" }): asks for notification permission once, then starts or updates. */
    @PluginMethod
    public void start(PluginCall call) {
        if (call.getString("journey") == null) {
            call.reject("Missing journey");
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "afterPermission");
            return;
        }
        launch(call);
    }

    @PermissionCallback
    private void afterPermission(PluginCall call) {
        launch(call); // without the permission the service still runs; Android hides its notification
    }

    private void launch(PluginCall call) {
        Intent i = new Intent(getContext(), LiveJourneyService.class);
        i.putExtra(LiveJourneyService.EXTRA_JOURNEY, call.getString("journey"));
        try {
            ContextCompat.startForegroundService(getContext(), i);
        } catch (Exception e) { // e.g. Android refuses a start while the app is in the background
            call.reject("Could not start live updates: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("notifications", Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED);
        call.resolve(ret);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (LiveJourneyService.running) {
            Intent i = new Intent(getContext(), LiveJourneyService.class).setAction(LiveJourneyService.ACTION_STOP);
            try {
                getContext().startService(i);
            } catch (Exception ignored) {
                getContext().stopService(new Intent(getContext(), LiveJourneyService.class));
            }
        }
        call.resolve();
    }
}
