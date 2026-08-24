package io.github.jaemanlee.codexpocketvoice;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PocketSpeechPlugin.class);
        registerPlugin(PocketTunnelPlugin.class);
        registerPlugin(PocketSecureStoragePlugin.class);
        registerPlugin(PocketJournalPlugin.class);
        registerPlugin(PocketNotificationsPlugin.class);
        registerPlugin(PocketUpdatePlugin.class);
        PocketNotificationsPlugin.captureIntent(this, getIntent());
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        PocketNotificationsPlugin.captureIntent(this, intent);
        super.onNewIntent(intent);
        setIntent(intent);
    }

    @Override
    public void onStart() {
        super.onStart();
        PocketNotificationsPlugin.setUiVisible(true);
    }

    @Override
    public void onStop() {
        PocketNotificationsPlugin.setUiVisible(false);
        super.onStop();
    }
}
