package io.github.jaemanlee.codexpocketvoice;

import android.Manifest;
import android.content.Intent;
import android.os.Bundle;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.speech.RecognitionListener;
import android.speech.RecognizerIntent;
import android.speech.SpeechRecognizer;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.Locale;

@CapacitorPlugin(
    name = "PocketSpeech",
    permissions = { @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO }) }
)
public class PocketSpeechPlugin extends Plugin implements RecognitionListener {
    private static final long RESTART_DELAY_MS = 280;
    private static final long COMPLETE_SILENCE_MS = 4_500;
    private static final long POSSIBLY_COMPLETE_SILENCE_MS = 2_800;
    private static final int MAX_BIASING_STRINGS = 32;
    private static final int MAX_BIASING_STRING_LENGTH = 120;

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private SpeechRecognizer recognizer;
    private String language = Locale.getDefault().toLanguageTag();
    private boolean continuous;
    private boolean listening;
    private boolean stopRequested = true;
    private ArrayList<String> biasingStrings = new ArrayList<>();

    @PluginMethod
    public void start(PluginCall call) {
        if (!SpeechRecognizer.isRecognitionAvailable(getContext())) {
            call.reject("이 기기에 사용할 수 있는 음성 인식 서비스가 없습니다.");
            return;
        }
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "permissionResult");
            return;
        }
        startRecognizer(call);
    }

    @PermissionCallback
    private void permissionResult(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            call.reject("마이크 권한을 허용해 주세요.");
            return;
        }
        startRecognizer(call);
    }

    private void startRecognizer(PluginCall call) {
        try {
            language = call.getString("language", Locale.getDefault().toLanguageTag());
            continuous = Boolean.TRUE.equals(call.getBoolean("continuous", false));
            biasingStrings = validatedBiasingStrings(call.getArray("phrases"));
        } catch (Exception error) {
            call.reject("프로젝트 음성 용어가 올바르지 않습니다.", error);
            return;
        }
        stopRequested = false;
        mainHandler.removeCallbacksAndMessages(null);
        mainHandler.post(() -> {
            ensureRecognizer();
            if (listening) recognizer.cancel();
            listening = false;
            beginListening();
        });

        JSObject result = new JSObject();
        result.put("started", true);
        result.put("continuous", continuous);
        call.resolve(result);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopRequested = true;
        continuous = false;
        mainHandler.removeCallbacksAndMessages(null);
        mainHandler.post(() -> {
            if (recognizer != null && listening) recognizer.stopListening();
            listening = false;
            emitState("stopped");
        });
        call.resolve();
    }

    private void ensureRecognizer() {
        if (recognizer != null) return;
        recognizer = SpeechRecognizer.createSpeechRecognizer(getContext());
        recognizer.setRecognitionListener(this);
    }

    private void beginListening() {
        if (stopRequested || recognizer == null) return;
        Intent intent = new Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE, language);
        intent.putExtra(RecognizerIntent.EXTRA_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_ONLY_RETURN_LANGUAGE_PREFERENCE, language);
        intent.putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1);
        intent.putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, COMPLETE_SILENCE_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS, POSSIBLY_COMPLETE_SILENCE_MS);
        intent.putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS, 1_500L);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU && !biasingStrings.isEmpty()) {
            intent.putStringArrayListExtra(RecognizerIntent.EXTRA_BIASING_STRINGS, biasingStrings);
        }
        try {
            recognizer.startListening(intent);
            listening = true;
            emitState("listening");
        } catch (Exception error) {
            listening = false;
            emitError("음성 인식을 시작하지 못했습니다: " + error.getMessage(), false);
        }
    }

    private void finishSession(boolean recoverable) {
        listening = false;
        if (continuous && !stopRequested && recoverable) {
            emitState("restarting");
            mainHandler.postDelayed(this::beginListening, RESTART_DELAY_MS);
        } else {
            stopRequested = true;
            emitState("stopped");
        }
    }

    private String firstTranscript(Bundle results) {
        if (results == null) return "";
        ArrayList<String> matches = results.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION);
        return matches == null || matches.isEmpty() ? "" : matches.get(0).trim();
    }

    private ArrayList<String> validatedBiasingStrings(JSArray values) throws Exception {
        if (values == null) return new ArrayList<>();
        if (values.length() > MAX_BIASING_STRINGS) throw new IllegalArgumentException("음성 용어가 너무 많습니다.");
        LinkedHashSet<String> unique = new LinkedHashSet<>();
        for (int index = 0; index < values.length(); index += 1) {
            String value = values.getString(index).replaceAll("[\\p{Cntrl}]", " ").replaceAll("\\s+", " ").trim();
            if (value.isEmpty() || value.length() > MAX_BIASING_STRING_LENGTH) {
                throw new IllegalArgumentException("음성 용어 길이가 올바르지 않습니다.");
            }
            unique.add(value);
        }
        return new ArrayList<>(unique);
    }

    private void emitTranscript(String eventName, String transcript) {
        if (transcript.isEmpty()) return;
        JSObject data = new JSObject();
        data.put("transcript", transcript);
        notifyListeners(eventName, data);
    }

    private void emitState(String state) {
        JSObject data = new JSObject();
        data.put("state", state);
        data.put("continuous", continuous && !stopRequested);
        notifyListeners("speechState", data);
    }

    private void emitError(String message, boolean recoverable) {
        JSObject data = new JSObject();
        data.put("message", message);
        data.put("recoverable", recoverable);
        notifyListeners("speechError", data);
    }

    @Override
    public void onReadyForSpeech(Bundle params) {
        emitState("listening");
    }

    @Override
    public void onBeginningOfSpeech() {}

    @Override
    public void onRmsChanged(float rmsdB) {}

    @Override
    public void onBufferReceived(byte[] buffer) {}

    @Override
    public void onEndOfSpeech() {
        emitState(continuous && !stopRequested ? "processing" : "stopping");
    }

    @Override
    public void onError(int error) {
        boolean recoverable = error == SpeechRecognizer.ERROR_NO_MATCH
            || error == SpeechRecognizer.ERROR_SPEECH_TIMEOUT
            || error == SpeechRecognizer.ERROR_RECOGNIZER_BUSY
            || error == SpeechRecognizer.ERROR_CLIENT;
        if (!stopRequested && !recoverable) {
            emitError(errorMessage(error), false);
        }
        finishSession(recoverable);
    }

    @Override
    public void onResults(Bundle results) {
        emitTranscript("speechFinal", firstTranscript(results));
        finishSession(true);
    }

    @Override
    public void onPartialResults(Bundle partialResults) {
        emitTranscript("speechPartial", firstTranscript(partialResults));
    }

    @Override
    public void onEvent(int eventType, Bundle params) {}

    private String errorMessage(int error) {
        switch (error) {
            case SpeechRecognizer.ERROR_AUDIO: return "마이크 입력 오류가 발생했습니다.";
            case SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS: return "마이크 권한이 없습니다.";
            case SpeechRecognizer.ERROR_NETWORK:
            case SpeechRecognizer.ERROR_NETWORK_TIMEOUT: return "음성 인식 네트워크 오류가 발생했습니다.";
            case SpeechRecognizer.ERROR_SERVER:
            case SpeechRecognizer.ERROR_SERVER_DISCONNECTED: return "음성 인식 서비스에 연결할 수 없습니다.";
            case SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED: return "선택한 언어의 음성 인식을 지원하지 않습니다.";
            case SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE: return "선택한 언어의 음성 모델을 사용할 수 없습니다.";
            default: return "음성 인식 오류가 발생했습니다. (" + error + ")";
        }
    }

    @Override
    protected void handleOnDestroy() {
        stopRequested = true;
        continuous = false;
        mainHandler.removeCallbacksAndMessages(null);
        if (recognizer != null) {
            recognizer.cancel();
            recognizer.destroy();
            recognizer = null;
        }
        super.handleOnDestroy();
    }
}
