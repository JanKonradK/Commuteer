package com.jankonradk.commuteer;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(AppUpdaterPlugin.class);
        registerPlugin(LiveJourneyPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
