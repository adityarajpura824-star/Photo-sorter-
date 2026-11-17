package com.photosorter.app;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.MediaStore;
import android.provider.Settings;
import android.util.Base64;
import android.util.Size;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Lets the page read the phone's whole gallery without a file picker:
 * permission, a list of every photo and video, a small preview of each, a fingerprint of each,
 * and a copy of each into Documents. Originals are only ever read.
 * Needs Android 10 or newer (minSdk 29).
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

    /** One page of the library. kind = "photo" | "video"; skip = a folder (under Documents) to leave out, like our own output. */
    @PluginMethod
    public void list(final PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                try {
                    boolean video = "video".equals(call.getString("kind", "photo"));
                    int offset = call.getInt("offset", 0);
                    int limit = call.getInt("limit", 1500);
                    String skip = call.getString("skip", "");
                    Uri base = video ? MediaStore.Video.Media.EXTERNAL_CONTENT_URI : MediaStore.Images.Media.EXTERNAL_CONTENT_URI;

                    String[] cols = video
                        ? new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT, MediaStore.MediaColumns.DURATION }
                        : new String[] { MediaStore.MediaColumns._ID, MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE, MediaStore.MediaColumns.SIZE, MediaStore.MediaColumns.DATE_TAKEN, MediaStore.MediaColumns.DATE_MODIFIED, MediaStore.MediaColumns.WIDTH, MediaStore.MediaColumns.HEIGHT };

                    String where = MediaStore.MediaColumns.SIZE + " > 0";
                    String[] args = null;
                    if (!skip.isEmpty()) {
                        where += " AND (" + MediaStore.MediaColumns.RELATIVE_PATH + " IS NULL OR " + MediaStore.MediaColumns.RELATIVE_PATH + " NOT LIKE ?)";
                        args = new String[] { "Documents/" + skip + "/%" };
                    }
                    Bundle q = new Bundle();
                    q.putString(ContentResolver.QUERY_ARG_SQL_SELECTION, where);
                    if (args != null) q.putStringArray(ContentResolver.QUERY_ARG_SQL_SELECTION_ARGS, args);
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
                            if (video) m.put("duration", c.isNull(8) ? 0 : c.getLong(8) / 1000.0);
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

    /** Copies the original into Documents/<path>. The original is only read. */
    @PluginMethod
    public void copy(final PluginCall call) {
        pool.execute(new Runnable() {
            @Override
            public void run() {
                File dest = null;
                try {
                    Uri uri = Uri.parse(call.getString("uri", ""));
                    String path = call.getString("path", "");
                    if (path.isEmpty() || path.startsWith("/") || path.contains("..")) throw new IllegalArgumentException("bad path");
                    dest = new File(Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOCUMENTS), path);
                    File dir = dest.getParentFile();
                    if (dir != null) dir.mkdirs();
                    long total = 0;
                    try (InputStream in = getContext().getContentResolver().openInputStream(uri);
                         OutputStream out = new FileOutputStream(dest)) {
                        byte[] buf = new byte[256 * 1024];
                        int n;
                        while ((n = in.read(buf)) > 0) {
                            out.write(buf, 0, n);
                            total += n;
                        }
                    }
                    JSObject r = new JSObject();
                    r.put("bytes", total);
                    call.resolve(r);
                } catch (Exception e) {
                    if (dest != null) dest.delete();
                    call.reject("Could not copy: " + e.getMessage());
                }
            }
        });
    }
}
