package com.ehfservices.hasslefreetv;

import android.app.Activity;
import android.net.Uri;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Hassle Free TV for Android TV / Google TV / Fire TV: a full-screen WebView showing https://tv.ehfservices.com/tv-app.
 * Everything outside Hassle Free TV is blocked, so kids can't wander off to other websites.
 */
public class MainActivity extends Activity {

    private static final String START = BuildConfig.START_URL;
    private static final String OFFLINE_HTML =
        "<html><body style='margin:0;background:#1b1446;color:#fff;font-family:sans-serif;display:flex;"
        + "align-items:center;justify-content:center;height:100vh;text-align:center'>"
        + "<div><h1 style='font-size:5vw'>No internet connection</h1>"
        + "<p style='font-size:2.4vw;color:#c9c3ff'>Hassle Free TV will try again in a few seconds&hellip;</p></div></body></html>";

    private WebView web;
    private String host;

    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);
        host = Uri.parse(START).getHost();

        web = new WebView(this);
        web.setBackgroundColor(0xFF1B1446);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);       // videos start when picked with the remote
        s.setSupportMultipleWindows(false);                 // links that try to open a new window stay here (and get blocked)
        s.setUserAgentString(s.getUserAgentString() + " HassleFreeTV/" + BuildConfig.VERSION_NAME);

        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(web, true);      // the YouTube player runs in an iframe

        web.addJavascriptInterface(new Bridge(), "HassleFreeTV");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest req) {
                if (!req.isForMainFrame()) return false;             // the YouTube player iframe is fine
                return !host.equals(req.getUrl().getHost());        // block every other website
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest req, WebResourceError err) {
                if (!req.isForMainFrame()) return;
                view.loadDataWithBaseURL(null, OFFLINE_HTML, "text/html", "utf-8", null);
                view.postDelayed(() -> view.loadUrl(START), 8000);
            }
        });

        if (state != null) web.restoreState(state);
        else web.loadUrl(START);
    }

    /** Back on the remote: let the page close the player / PIN pad first; exit only from the home screen. */
    @Override
    public boolean dispatchKeyEvent(KeyEvent e) {
        if (e.getKeyCode() == KeyEvent.KEYCODE_BACK) {
            if (e.getAction() == KeyEvent.ACTION_UP) {
                web.evaluateJavascript("(window.kytBack && window.kytBack()) ? 'y' : 'n'", result -> {
                    if (!"\"y\"".equals(result)) finish();
                });
            }
            return true;
        }
        return super.dispatchKeyEvent(e);
    }

    @Override
    protected void onPause() {
        web.evaluateJavascript("window.kytPause && window.kytPause()", null);
        CookieManager.getInstance().flush();
        web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        super.onResume();
        web.onResume();
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        web.saveState(out);
    }

    @Override
    protected void onDestroy() {
        web.destroy();
        super.onDestroy();
    }

    /** Small bridge the page can call as window.HassleFreeTV.* */
    private class Bridge {
        @JavascriptInterface
        public void keepAwake(boolean on) {
            runOnUiThread(() -> {
                if (on) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
                else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            });
        }

        @JavascriptInterface
        public void saveCookies() {
            CookieManager.getInstance().flush();
        }
    }
}
