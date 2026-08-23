package io.github.jaemanlee.codexpocketvoice;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;

@CapacitorPlugin(name = "PocketJournal")
public class PocketJournalPlugin extends Plugin {
    private static final int INDEX_BYTES = 64;
    private static final int MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
    private JournalDatabase database;

    @PluginMethod
    public void getConversation(PluginCall call) {
        String key = validatedIndex(call, "key");
        if (key == null) return;
        read(call, "conversations", "journal_key", key);
    }

    @PluginMethod
    public void putConversation(PluginCall call) {
        String key = validatedIndex(call, "key");
        if (key == null) return;
        write(call, "conversations", "journal_key", key);
    }

    @PluginMethod
    public void getQueue(PluginCall call) {
        String device = validatedIndex(call, "device");
        if (device == null) return;
        read(call, "queues", "device_id", device);
    }

    @PluginMethod
    public void putQueue(PluginCall call) {
        String device = validatedIndex(call, "device");
        if (device == null) return;
        write(call, "queues", "device_id", device);
    }

    private void read(PluginCall call, String table, String column, String key) {
        try (Cursor cursor = helper().getReadableDatabase().query(
                table,
                new String[] { "payload" },
                column + " = ?",
                new String[] { key },
                null,
                null,
                null,
                "1")) {
            JSObject result = new JSObject();
            result.put("payload", cursor.moveToFirst() ? cursor.getString(0) : null);
            call.resolve(result);
        } catch (Exception error) {
            call.reject("암호화된 작업 저널을 읽을 수 없습니다.", error);
        }
    }

    private void write(
            PluginCall call,
            String table,
            String column,
            String key) {
        String payload = call.getString("payload");
        if (!isValidEncryptedEnvelope(payload)) {
            call.reject("암호화된 작업 저널 payload가 올바르지 않습니다.");
            return;
        }
        try {
            ContentValues values = new ContentValues();
            values.put(column, key);
            values.put("payload", payload);
            values.put("updated_at", System.currentTimeMillis());
            long rowId = helper().getWritableDatabase().insertWithOnConflict(
                table,
                null,
                values,
                SQLiteDatabase.CONFLICT_REPLACE
            );
            if (rowId == -1) {
                call.reject("암호화된 작업 저널을 저장할 수 없습니다.");
                return;
            }
            call.resolve();
        } catch (Exception error) {
            call.reject("암호화된 작업 저널을 저장할 수 없습니다.", error);
        }
    }

    private String validatedIndex(PluginCall call, String name) {
        String value = call.getString(name);
        if (value == null || byteLength(value) != INDEX_BYTES || !value.matches("[a-f0-9]{64}")) {
            call.reject("유효한 " + name + "가 필요합니다.");
            return null;
        }
        return value;
    }

    private boolean isValidEncryptedEnvelope(String payload) {
        if (payload == null || payload.isEmpty() || byteLength(payload) > MAX_PAYLOAD_BYTES) return false;
        try {
            JSONObject envelope = new JSONObject(payload);
            Object version = envelope.opt("version");
            return envelope.length() == 3
                && version instanceof Number
                && ((Number) version).intValue() == 2
                && !envelope.optString("iv", "").isEmpty()
                && !envelope.optString("ciphertext", "").isEmpty();
        } catch (Exception error) {
            return false;
        }
    }

    private int byteLength(String value) {
        return value.getBytes(StandardCharsets.UTF_8).length;
    }

    private JournalDatabase helper() {
        if (database == null) database = new JournalDatabase();
        return database;
    }

    @Override
    protected void handleOnDestroy() {
        if (database != null) {
            database.close();
            database = null;
        }
        super.handleOnDestroy();
    }

    private class JournalDatabase extends SQLiteOpenHelper {
        private static final String DATABASE_NAME = "codex_pocket_work_journal.db";
        private static final int DATABASE_VERSION = 1;

        JournalDatabase() {
            super(getContext().getApplicationContext(), DATABASE_NAME, null, DATABASE_VERSION);
            setWriteAheadLoggingEnabled(true);
        }

        @Override
        public void onConfigure(SQLiteDatabase database) {
            super.onConfigure(database);
            database.setForeignKeyConstraintsEnabled(true);
        }

        @Override
        public void onCreate(SQLiteDatabase database) {
            database.execSQL(
                "CREATE TABLE conversations ("
                    + "journal_key TEXT PRIMARY KEY NOT NULL, "
                    + "payload TEXT NOT NULL, "
                    + "updated_at INTEGER NOT NULL)"
            );
            database.execSQL(
                "CREATE TABLE queues ("
                    + "device_id TEXT PRIMARY KEY NOT NULL, "
                    + "payload TEXT NOT NULL, "
                    + "updated_at INTEGER NOT NULL)"
            );
        }

        @Override
        public void onUpgrade(SQLiteDatabase database, int oldVersion, int newVersion) {
            throw new IllegalStateException("지원되지 않는 작업 저널 schema upgrade입니다.");
        }
    }
}
