package com.example.aichat;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.SharedPreferences;
import android.os.Bundle;
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
        keyInput.setText(prefs.getString("api_key", ""));

        Button startButton = new Button(this);
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
            prefs.edit().putString("api_key", apiKey).apply();
            startServerOnce(apiKey);
            // Beri waktu server lokal menyala sebelum memuat.
            webView.postDelayed(() -> webView.loadUrl("http://127.0.0.1:" + PORT + "/"), 1200);
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
