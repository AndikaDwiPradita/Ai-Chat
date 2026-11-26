package com.example.aichat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
import android.view.View;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;

import com.chaquo.python.Python;
import com.chaquo.python.android.AndroidPlatform;

/**
 * Standalone Android app: Chaquopy menjalankan backend Flask di dalam APK
 * (127.0.0.1:PORT), WebView membuka aplikasi web lokal. Tidak perlu server
 * terpisah; fitur AI tetap butuh ORCAROUTER_API_KEY + internet.
 *
 * Token bisa diisi manual, atau disuntik saat build (BuildConfig.DEFAULT_ORCA_KEY
 * dari -PorcaKey / GitHub secret) tanpa disimpan di source repo.
 */
public class MainActivity extends Activity {

    private static final int PORT = 8765;
    private static boolean serverStarted = false;

    private WebView webView;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        if (!Python.isStarted()) {
            Python.start(new AndroidPlatform(this));
        }

        final SharedPreferences prefs = getSharedPreferences("aichat", MODE_PRIVATE);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        final EditText keyInput = new EditText(this);
        keyInput.setHint("ORCAROUTER_API_KEY");
        keyInput.setSingleLine(true);
        // isi: yang tersimpan; kalau kosong, token default saat build (kalau ada)
        String saved = prefs.getString("api_key", null);
        keyInput.setText(saved != null ? saved : BuildConfig.DEFAULT_ORCA_KEY);

        final Button startButton = new Button(this);
        startButton.setText("Buka Ai-Chat");

        webView = new WebView(this);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        webView.setWebViewClient(new WebViewClient());
        webView.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        root.addView(keyInput);
        root.addView(startButton);
        root.addView(webView);
        setContentView(root);

        startButton.setOnClickListener(v -> {
            String apiKey = keyInput.getText().toString().trim();
            if (apiKey.isEmpty()) {
                apiKey = BuildConfig.DEFAULT_ORCA_KEY;
            }
            prefs.edit().putString("api_key", apiKey).apply();

            // BUG FIX: setelah mulai, sembunyikan kolom token + tombol; tinggal chat.
            keyInput.setVisibility(View.GONE);
            startButton.setVisibility(View.GONE);

            startServerOnce(apiKey);

            final String url = "http://127.0.0.1:" + PORT + "/";
            // Beri waktu server lokal menyala; muat ulang sekali lagi setelahnya.
            webView.postDelayed(() -> webView.loadUrl(url), 1200);
            webView.postDelayed(webView::reload, 2600);
        });
    }

    private void startServerOnce(String apiKey) {
        if (serverStarted) {
            return;
        }
        serverStarted = true;
        final String filesDir = getFilesDir().getAbsolutePath();
        new Thread(() -> Python.getInstance()
                .getModule("android_main")
                .callAttr("start_server", PORT, apiKey, filesDir)).start();
    }
}
