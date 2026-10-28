package com.jankonradk.commuteer;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.content.FileProvider;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Installs a Commuteer release from GitHub (adapted from Memoria's updater). The APK is checked against the
 * release's SHA256SUMS.txt, then Android's own installer asks the user to
 * confirm. Android only accepts it when it carries this app's signature.
 */
@CapacitorPlugin(name = "AppUpdater")
public class AppUpdaterPlugin extends Plugin {
    private static final String RELEASES = "https://github.com/JanKonradK/Commuteer/releases/download/";
    private static final String APK_NAME = "Commuteer-android.apk";
    private static final long MAX_APK_BYTES = 300L * 1024 * 1024;
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private volatile boolean busy = false;

    @PluginMethod
    public void install(PluginCall call) {
        String apkUrl = call.getString("apkUrl");
        String checksumUrl = call.getString("checksumUrl");
        String version = call.getString("version", "").replaceAll("[^0-9A-Za-z.-]", "");
        if (apkUrl == null || checksumUrl == null || !apkUrl.startsWith(RELEASES) || !checksumUrl.startsWith(RELEASES)) {
            call.reject("This download does not come from Commuteer's releases.");
            return;
        }
        if (busy) {
            call.reject("An update is already downloading.");
            return;
        }
        Context context = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !context.getPackageManager().canRequestPackageInstalls()) {
            Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + context.getPackageName()));
            getActivity().startActivity(settings);
            call.reject("Allow Commuteer to install apps, then tap Install again.", "INSTALL_PERMISSION");
            return;
        }
        busy = true;
        executor.execute(() -> {
            try {
                String expected = expectedDigest(checksumUrl);
                File directory = new File(context.getCacheDir(), "updates");
                if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("No room for the update.");
                File apk = new File(directory, "Commuteer-" + version + ".apk");
                // A verified copy from an earlier attempt is reused, anything else is replaced.
                if (!apk.isFile() || !expected.equals(sha256(apk))) {
                    File[] old = directory.listFiles();
                    if (old != null) for (File file : old) file.delete();
                    download(apkUrl, apk);
                    if (!expected.equals(sha256(apk))) {
                        apk.delete();
                        throw new IOException("The download is damaged. Try again.");
                    }
                }
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", apk);
                Intent installer = new Intent(Intent.ACTION_VIEW);
                installer.setDataAndType(uri, "application/vnd.android.package-archive");
                installer.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
                getActivity().runOnUiThread(() -> {
                    try {
                        getActivity().startActivity(installer);
                        call.resolve();
                    } catch (RuntimeException error) {
                        call.reject("Android could not open its installer.", error);
                    }
                });
            } catch (Exception error) {
                String message = error.getMessage();
                call.reject(message == null || message.isEmpty() ? "The update could not be downloaded. Try again." : message);
            } finally {
                busy = false;
            }
        });
    }

    private static HttpURLConnection open(String url) throws IOException {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(30_000);
        connection.setReadTimeout(60_000);
        connection.setRequestProperty("User-Agent", "Commuteer-updater (+https://github.com/JanKonradK/Commuteer)");
        int status = connection.getResponseCode();
        if (status != HttpURLConnection.HTTP_OK) {
            connection.disconnect();
            throw new IOException("GitHub responded " + status + ". Try again later.");
        }
        return connection;
    }

    private static String expectedDigest(String checksumUrl) throws IOException {
        HttpURLConnection connection = open(checksumUrl);
        try (InputStream input = connection.getInputStream()) {
            ByteArrayOutputStream text = new ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = input.read(buffer)) != -1) {
                text.write(buffer, 0, read);
                if (text.size() > 64_000) throw new IOException("The checksum list is too large.");
            }
            for (String line : text.toString(StandardCharsets.UTF_8.name()).split("\\r?\\n")) {
                String[] parts = line.trim().split("\\s+\\*?", 2);
                if (parts.length == 2 && parts[1].equals(APK_NAME) && parts[0].matches("[0-9a-fA-F]{64}")) {
                    return parts[0].toLowerCase(Locale.ROOT);
                }
            }
        } finally {
            connection.disconnect();
        }
        throw new IOException("This release does not list an Android checksum.");
    }

    private void download(String url, File destination) throws IOException {
        HttpURLConnection connection = open(url);
        long total = connection.getContentLengthLong();
        if (total > MAX_APK_BYTES) {
            connection.disconnect();
            throw new IOException("The download is larger than expected.");
        }
        long received = 0;
        long lastReport = 0;
        try (InputStream input = connection.getInputStream(); OutputStream output = new FileOutputStream(destination)) {
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) {
                received += read;
                if (received > MAX_APK_BYTES) throw new IOException("The download is larger than expected.");
                output.write(buffer, 0, read);
                long now = System.currentTimeMillis();
                if (now - lastReport > 200) {
                    lastReport = now;
                    JSObject progress = new JSObject();
                    progress.put("received", received);
                    progress.put("total", total);
                    notifyListeners("progress", progress);
                }
            }
        } catch (IOException error) {
            destination.delete();
            throw error;
        } finally {
            connection.disconnect();
        }
    }

    private static String sha256(File file) throws IOException {
        try (InputStream input = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
            StringBuilder hex = new StringBuilder();
            for (byte value : digest.digest()) hex.append(String.format(Locale.ROOT, "%02x", value));
            return hex.toString();
        } catch (java.security.NoSuchAlgorithmException error) {
            throw new IOException("This device cannot check downloads.", error);
        }
    }
}
