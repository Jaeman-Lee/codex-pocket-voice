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
        super.onCreate(savedInstanceState);
        PocketNotificationsPlugin.captureIntent(this, getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        PocketNotificationsPlugin.captureIntent(this, intent);
    }
}
