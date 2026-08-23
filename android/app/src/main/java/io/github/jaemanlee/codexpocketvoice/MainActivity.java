package io.github.jaemanlee.codexpocketvoice;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(PocketSpeechPlugin.class);
        registerPlugin(PocketTunnelPlugin.class);
        registerPlugin(PocketSecureStoragePlugin.class);
        registerPlugin(PocketJournalPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
