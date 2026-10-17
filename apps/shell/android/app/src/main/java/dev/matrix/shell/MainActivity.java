package dev.matrix.shell;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override public void onCreate(android.os.Bundle state) {
        registerPlugin(PlatformSessionsPlugin.class);
        super.onCreate(state);
    }
    @Override protected void onNewIntent(android.content.Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (bridge != null) bridge.triggerWindowJSEvent("matrix-notification");
    }
}
