package com.photosorter.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class); // before super.onCreate, so the page can see it
        super.onCreate(savedInstanceState);
    }
}
