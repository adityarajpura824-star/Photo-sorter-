package com.photosorter.app;

import android.Manifest;
import android.app.Activity;
import android.app.PendingIntent;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.ContentValues;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;

import androidx.activity.result.ActivityResult;
import androidx.activity.result.IntentSenderRequest;
import androidx.activity.result.contract.ActivityResultContracts;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import org.json.JSONObject;

/**
 * Lets the page work with the phone's whole gallery without a file picker:
 * permission, a list of every photo and video, a small preview of each, a fingerprint of each,
 * and moving them into other gallery folders (Android asks the person to allow each batch). Nothing is copied.
 * Needs Android 11 or newer (minSdk 30).
 */
@CapacitorPlugin(
    name = "MediaLibrary",
    permissions = {
        @Permission(alias = "media13", strings = { Manifest.permission.READ_MEDIA_IMAGES, Manifest.permission.READ_MEDIA_VIDEO }),
        @Permission(alias = "media10", strings = { Manifest.permission.READ_EXTERNAL_STORAGE })
    }
)
public class MediaLibraryPlugin extends Plugin {

    // A few files at once: thumbnails and fingerprints are mostly waiting on the disk.
    private final ExecutorService pool = Executors.newFixedThreadPool(3);

    private static final long LIMIT = 16L << 20; // same rule as the page: bigger files hash size + 3 x 4 MB samples
    private static final long SAMPLE = 4L << 20;

    private String alias() {
        return Build.VERSION.SDK_INT >= 33 ? "media13" : "media10";
    }

    private void accessReply(PluginCall call) {
        JSObject r = new JSObject();
        r.put("granted", getPermissionState(alias()) == PermissionState.GRANTED);
        call.resolve(r);
    }

    @PluginMethod
    public void requestAccess(PluginCall call) {
        if (getPermissionState(alias()) == PermissionState.GRANTED) {
            accessReply(call);
        } else {
            requestPermissionForAlias(alias(), call, "accessResult");
        }
    }

    @PermissionCallback
    private void accessResult(PluginCall call) {
        accessReply(call);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", getContext().getPackageName(), null));
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(i);
        call.resolve();
    }

    /** One page of the library. kind = "photo" | "video". */
    @PluginMethod
    public void list(final PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    boolean video = "video".equals(call.getString("kind", "photo"));
                    int offset = call.getInt("offset", 0);
                    int limit = call.getInt("limit", 1500);
                    Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

                    String[] cols = video
                        ? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.RELATIVE_PATH, MediaStore.MediaColumns.DURATION }
                        : new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.RELATIVE_PATH };

                    String where = MediaStore.MediaColumns.SIZE + " > 0";
                    Bundle q = new Bundle();
                    q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, where);
                    q.putString(ContentResolver.QUERY_ARG_SQL_SORT_ORDER, MediaStore.MediaColumns._ID + " ASC");
                    q.putInt(ContentResolver.QUERY_ARG_LIMIT, limit);
                    q.putInt(ContentResolver.QUERY_ARG_OFFSET, offset);

                    JSArray items = new JSArray();
                    try (Cursor c = getContext().getContentResolver().query(base, cols, q, null)) {
                        while (c != null && c.moveToNext()) {
                            JSObject m = new JSObject();
                            m.put("uri", ContentUris.withAppendedId(base, c.getLong(0)).toString());
                            m.put("name", c.isNull(1) ? "unnamed" : c.getString(1));
                            m.put("type", c.isNull(2) ? "" : c.getString(2));
                            m.put("size", c.getLong(3));
                            long taken = c.isNull(4) ? 0 : c.getLong(4);
                            m.put("taken", taken > 0 ? taken : c.getLong(5) * 1000L);
                            m.put("w", c.isNull(6) ? 0 : c.getInt(6));
                            m.put("h", c.isNull(7) ? 0 : c.getInt(7));
                            m.put("rel", c.isNull(8) ? "" : c.getString(8));
                            if (video) m.put("duration", c.isNull(9) ? 0 : c.getLong(9) / 1000.0);
                            items.put(m);
                        }
                    }
                    JSObject r = new JSObject();
                    r.put("items", items);
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("Could not read the gallery: " + e.getMessage());
                }
            }
        });
    }

    /** A small JPEG preview (a photo, or a frame of a video), as base64. */
    @PluginMethod
    public void thumb(final PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    Uri uri = Uri.parse(call.getString("uri", ""));
                    int px = call.getInt("size", 256);
                    Bitmap b = getContext().getContentResolver().loadThumbnail(uri, new Size(px, px), null);
                    ByteArrayOutputStream o = new ByteArrayOutputStream();
                    b.compress(Bitmap.CompressFormat.JPEG, 85, o);
                    JSObject r = new JSObject();
                    r.put("data", Base64.encodeToString(o.toByteArray(), Base64.NO_WRAP));
                    r.put("w", b.getWidth());
                    r.put("h", b.getHeight());
                    b.recycle();
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("No preview: " + e.getMessage());
                }
            }
        });
    }

    /** SHA-256 of the file (of its size plus three 4 MB samples when it is over 16 MB), as lowercase hex. */
    @PluginMethod
    public void sha(final PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    Uri uri = Uri.parse(call.getString("uri", ""));
                    MessageDigest md = MessageDigest.getInstance("SHA-256");
                    try (ParcelFileDescriptor pfd = getContext().getContentResolver().openFileDescriptor(uri, "r");
                         FileInputStream in = new FileInputStream(pfd.getFileDescriptor())) {
                        FileChannel ch = in.getChannel();
                        long size = ch.size();
                        if (size <= LIMIT) {
                            feed(ch, 0, size, md);
                        } else {
                            md.update(String.valueOf(size).getBytes(StandardCharsets.UTF_8));
                            feed(ch, 0, SAMPLE, md);
                            feed(ch, (size - SAMPLE) >> 1, SAMPLE, md);
                            feed(ch, size - SAMPLE, SAMPLE, md);
                        }
                    }
                    StringBuilder hex = new StringBuilder();
                    for (byte x : md.digest()) hex.append(String.format("%02x", x));
                    JSObject r = new JSObject();
                    r.put("sha", hex.toString());
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("Could not read the file: " + e.getMessage());
                }
            }
        });
    }

    private static void feed(FileChannel ch, long from, long count, MessageDigest md) throws Exception {
        ByteBuffer buf = ByteBuffer.allocate(1 << 20);
        long pos = from, end = from + count;
        while (pos < end) {
            buf.clear();
            if (end - pos < buf.capacity()) buf.limit((int) (end - pos));
            int n = ch.read(buf, pos);
            if (n <= 0) break;
            md.update(buf.array(), 0, n);
            pos += n;
        }
    }

    /**
     * Moves files into other gallery folders by changing their folder in MediaStore: instant, no copy, nothing extra stored.
     * Android shows its own "Allow Photo Sorter to modify these items?" box once per call, so the page sends batches.
     * moves = [{ uri, to: "Pictures/Photo Sorter/Food/", name }]  ->  { moved: [{ uri, name }], failed: [uri] } or { denied: true }
     */
    @PluginMethod
    public void move(PluginCall call) {
        try {
            JSArray moves = call.getArray("moves");
            List<Uri> uris = new ArrayList<>();
            for (int i = 0; i < moves.length(); i++) uris.add(Uri.parse(moves.getJSONObject(i).getString("uri")));
            if (uris.isEmpty()) {
                JSObject r = new JSObject();
                r.put("moved", new JSArray());
                r.put("failed", new JSArray());
                call.resolve(r);
                return;
            }
            PendingIntent pi = MediaStore.createWriteRequest(getContext().getContentResolver(), uris);
            Intent intent = new Intent(ActivityResultContracts.StartIntentSenderForResult.ACTION_INTENT_SENDER_REQUEST)
                .putExtra(ActivityResultContracts.StartIntentSenderForResult.EXTRA_INTENT_SENDER_REQUEST, new IntentSenderRequest.Builder(pi).build());
            startActivityForResult(call, intent, "moveAllowed");
        } catch (Exception e) {
            call.reject("Could not ask Android for permission: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void moveAllowed(final PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK) {
            JSObject r = new JSObject();
            r.put("denied", true);
            call.resolve(r);
            return;
        }
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    ContentResolver cr = getContext().getContentResolver();
                    JSArray moves = call.getArray("moves"), moved = new JSArray(), failed = new JSArray();
                    for (int i = 0; i < moves.length(); i++) {
                        JSONObject m = moves.getJSONObject(i);
                        String uri = m.getString("uri"), name = m.getString("name");
                        try {
                            ContentValues v = new ContentValues();
                            v.put(MediaStore.MediaColumns.RELATIVE_PATH, m.getString("to"));
                            v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                            int n;
                            try {
                                n = cr.update(Uri.parse(uri), v, null, null);
                            } catch (Exception taken) { // a file with that name is already in that folder: add the id to the name
                                int dot = name.lastIndexOf('.');
                                String id = Uri.parse(uri).getLastPathSegment();
                                name = dot < 0 ? name + "_" + id : name.substring(0, dot) + "_" + id + name.substring(dot);
                                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                                n = cr.update(Uri.parse(uri), v, null, null);
                            }
                            if (n > 0) {
                                JSObject ok = new JSObject();
                                ok.put("uri", uri);
                                ok.put("name", name);
                                moved.put(ok);
                            } else {
                                failed.put(uri);
                            }
                        } catch (Exception e) {
                            failed.put(uri);
                        }
                    }
                    JSObject r = new JSObject();
                    r.put("moved", moved);
                    r.put("failed", failed);
                    call.resolve(r);
                } catch (Exception e) {
                    call.reject("Could not move: " + e.getMessage());
                }
            }
        });
    }
}
