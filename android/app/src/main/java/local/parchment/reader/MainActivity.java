// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2026 Jo

package local.parchment.reader;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.database.Cursor;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.OpenableColumns;
import android.view.View;
import android.view.Window;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parchment for Android: a WebView that shows the standalone page (assets/parchment.html).
 * The page has the Theme bar (all five themes), Open, and Close. This class adds
 * Open with, Share, the system file picker, clipboard, external links, and system bar colors.
 */
public class MainActivity extends Activity {
    private static final String PAGE = "file:///android_asset/parchment.html";
    private static final int MAX_BYTES = 10 * 1024 * 1024;
    private static final int REQUEST_PICK = 1;
    private static final Pattern RGB = Pattern.compile("(\\d+)\\D+(\\d+)\\D+(\\d+)");

    private final Object lock = new Object();
    private FrameLayout root;
    private WebView web;
    private ValueCallback<Uri[]> chooserCallback;
    private String pending; // JSON for the page, or null
    private File cacheText;
    private File cacheName;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        cacheText = new File(getCacheDir(), "open-doc.md");
        cacheName = new File(getCacheDir(), "open-doc.name");

        root = new FrameLayout(this);
        web = new WebView(this);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        drawBehindSystemBars();

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the theme choice is kept in localStorage
        s.setAllowFileAccess(false);  // file:///android_asset/ still works
        s.setAllowContentAccess(false);
        s.setSupportMultipleWindows(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        if ((getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The page stays put. Any other address goes to the system, if it is safe.
                Uri u = request.getUrl();
                if (PAGE.equals(u.toString())) return false;
                openExternal(u.toString());
                return true;
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (chooserCallback != null) chooserCallback.onReceiveValue(null);
                chooserCallback = callback;
                // Many devices have no MIME type for .md, so a type filter would grey them out.
                // The page rejects binary files.
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(pick, REQUEST_PICK);
                } catch (ActivityNotFoundException e) {
                    Intent get = new Intent(Intent.ACTION_GET_CONTENT);
                    get.addCategory(Intent.CATEGORY_OPENABLE);
                    get.setType("*/*");
                    try {
                        startActivityForResult(get, REQUEST_PICK);
                    } catch (ActivityNotFoundException e2) {
                        chooserCallback = null;
                        return false;
                    }
                }
                return true;
            }
        });

        web.addJavascriptInterface(new Bridge(), "ParchmentAndroid");

        if (savedInstanceState != null) {
            restoreCachedDoc(); // recreated, for example after a dark mode switch
        } else {
            handleIntent(getIntent());
        }
        web.loadUrl(PAGE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntent(intent);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_PICK || chooserCallback == null) return;
        Uri[] result = null;
        if (resultCode == RESULT_OK && data != null && data.getData() != null) {
            result = new Uri[] { data.getData() };
        }
        chooserCallback.onReceiveValue(result);
        chooserCallback = null;
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onPause() {
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("ParchmentAndroid");
            web.destroy();
        }
        super.onDestroy();
    }

    // ---- Files from Open with and Share -------------------------------------

    private void handleIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        if (Intent.ACTION_VIEW.equals(action) && intent.getData() != null) {
            readInBackground(intent.getData());
        } else if (Intent.ACTION_SEND.equals(action)) {
            Uri stream = streamExtra(intent);
            if (stream != null) {
                readInBackground(stream);
            } else {
                CharSequence text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (text != null) {
                    String subject = intent.getStringExtra(Intent.EXTRA_SUBJECT);
                    setPending(docJson(subject != null ? subject : "Shared text", text.toString(), false));
                    askPageToPull();
                }
            }
        }
    }

    @SuppressWarnings("deprecation")
    private static Uri streamExtra(Intent intent) {
        if (Build.VERSION.SDK_INT >= 33) return intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class);
        Object o = intent.getParcelableExtra(Intent.EXTRA_STREAM);
        return o instanceof Uri ? (Uri) o : null;
    }

    /** Reads off the main thread: a cloud provider can be slow. */
    private void readInBackground(Uri uri) {
        new Thread(() -> {
            String json;
            String name = displayName(uri);
            try {
                json = docJson(name, readText(uri), false);
            } catch (IOException e) {
                json = errorJson(name + ": " + e.getMessage());
            } catch (SecurityException e) {
                json = errorJson(name + ": permission denied.");
            }
            setPending(json);
            runOnUiThread(this::askPageToPull);
        }, "parchment-read").start();
    }

    private String readText(Uri uri) throws IOException {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new IOException("The file did not open.");
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) != -1) {
                for (int i = 0; i < n; i++) {
                    if (buf[i] == 0) throw new IOException("The file is not a text file.");
                }
                out.write(buf, 0, n);
                if (out.size() > MAX_BYTES) throw new IOException("The file is larger than 10 MB.");
            }
            return new String(out.toByteArray(), StandardCharsets.UTF_8);
        }
    }

    private String displayName(Uri uri) {
        try (Cursor c = getContentResolver().query(uri,
                new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null)) {
            if (c != null && c.moveToFirst()) {
                int i = c.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (i >= 0 && c.getString(i) != null) return c.getString(i);
            }
        } catch (RuntimeException ignored) {
            // Fall back to the address.
        }
        String last = uri.getLastPathSegment();
        return last != null ? last : "Document.md";
    }

    private static String docJson(String name, String text, boolean restore) {
        try {
            JSONObject o = new JSONObject();
            o.put("name", name);
            o.put("text", text);
            if (restore) o.put("restore", true);
            return o.toString();
        } catch (JSONException e) {
            return errorJson("The file did not open.");
        }
    }

    private static String errorJson(String message) {
        try {
            return new JSONObject().put("error", message).toString();
        } catch (JSONException e) {
            return "{\"error\":\"The file did not open.\"}";
        }
    }

    private void setPending(String json) {
        synchronized (lock) {
            pending = json;
        }
    }

    /** The page also pulls on start and when it becomes visible. This covers the rest. */
    private void askPageToPull() {
        if (web != null) {
            web.evaluateJavascript("window.parchmentAndroidPull && window.parchmentAndroidPull()", null);
        }
    }

    // ---- Keep the open file across a recreate --------------------------------

    private void restoreCachedDoc() {
        synchronized (lock) {
            if (!cacheText.exists() || !cacheName.exists()) return;
            try {
                String name = new String(Files.readAllBytes(cacheName.toPath()), StandardCharsets.UTF_8);
                String text = new String(Files.readAllBytes(cacheText.toPath()), StandardCharsets.UTF_8);
                pending = docJson(name, text, true);
            } catch (IOException ignored) {
                // Start empty.
            }
        }
    }

    private void writeCache(String name, String text) {
        synchronized (lock) {
            try (FileOutputStream a = new FileOutputStream(cacheText);
                 FileOutputStream b = new FileOutputStream(cacheName)) {
                a.write(text.getBytes(StandardCharsets.UTF_8));
                b.write(name.getBytes(StandardCharsets.UTF_8));
            } catch (IOException e) {
                clearCache(); // a partial copy is worse than none
            }
        }
    }

    private void clearCache() {
        synchronized (lock) {
            //noinspection ResultOfMethodCallIgnored
            cacheText.delete();
            //noinspection ResultOfMethodCallIgnored
            cacheName.delete();
        }
    }

    // ---- System bars --------------------------------------------------------

    /** The page draws behind the status and navigation bars; padding keeps text clear of them. */
    @SuppressWarnings("deprecation")
    private void drawBehindSystemBars() {
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 29) {
            w.setStatusBarContrastEnforced(false);
            w.setNavigationBarContrastEnforced(false);
        }
        if (Build.VERSION.SDK_INT >= 30) {
            w.setDecorFitsSystemWindows(false);
        } else {
            w.getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
        }
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = insets.getInsets(
                        WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                v.setPadding(i.left, i.top, i.right, i.bottom);
                return WindowInsets.CONSUMED;
            }
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                    insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        root.requestApplyInsets();
    }

    @SuppressWarnings("deprecation")
    private void setChromeOnUi(int color, boolean light) {
        root.setBackgroundColor(color);
        Window w = getWindow();
        if (Build.VERSION.SDK_INT >= 30) {
            WindowInsetsController c = w.getInsetsController();
            if (c != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                c.setSystemBarsAppearance(light ? mask : 0, mask);
            }
        } else {
            int flags = View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                    | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION;
            if (light) flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
            w.getDecorView().setSystemUiVisibility(flags);
        }
    }

    // ---- Links --------------------------------------------------------------

    private void openExternal(String href) {
        if (href == null || href.length() > 4096) return;
        Uri u = Uri.parse(href);
        String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
        if (!scheme.equals("https") && !scheme.equals("http") && !scheme.equals("mailto")) return;
        runOnUiThread(() -> {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW, u));
            } catch (ActivityNotFoundException ignored) {
                // No app for this address.
            }
        });
    }

    // ---- The page's bridge (window.ParchmentAndroid) -------------------------
    // These run on a WebView background thread.

    private final class Bridge {
        @JavascriptInterface
        public String takePending() {
            synchronized (lock) {
                String p = pending;
                pending = null;
                return p == null ? "" : p;
            }
        }

        @JavascriptInterface
        public void opened(String name, String text) {
            if (name == null || text == null || text.length() > MAX_BYTES) return;
            writeCache(name, text);
        }

        @JavascriptInterface
        public void closed() {
            clearCache();
        }

        @JavascriptInterface
        public void copy(String text) {
            if (text == null || text.length() > 1_000_000) return;
            runOnUiThread(() -> {
                ClipboardManager cm = getSystemService(ClipboardManager.class);
                if (cm != null) cm.setPrimaryClip(ClipData.newPlainText("Code", text));
            });
        }

        @JavascriptInterface
        public void openExternal(String href) {
            MainActivity.this.openExternal(href);
        }

        @JavascriptInterface
        public void setChrome(String cssColor, boolean light) {
            if (cssColor == null) return;
            Matcher m = RGB.matcher(cssColor);
            if (!m.find()) return;
            int color = Color.rgb(clamp(m.group(1)), clamp(m.group(2)), clamp(m.group(3)));
            runOnUiThread(() -> setChromeOnUi(color, light));
        }

        private int clamp(String v) {
            try {
                return Math.max(0, Math.min(255, Integer.parseInt(v)));
            } catch (NumberFormatException e) {
                return 0;
            }
        }
    }
}
