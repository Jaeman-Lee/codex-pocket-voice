package io.github.jaemanlee.codexpocketvoice;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

public final class PocketReconnectSignalTest {
    @Test(timeout = 1_000L)
    public void signalBeforeWaitSkipsTheEntireBackoff() {
        PocketReconnectSignal signal = new PocketReconnectSignal();
        AtomicBoolean active = new AtomicBoolean(true);
        long observed = signal.currentGeneration();

        signal.signal();

        assertTrue(signal.awaitRetry(observed, 60_000L, active));
    }

    @Test
    public void networkSignalInterruptsAWaitingBackoff() throws Exception {
        PocketReconnectSignal signal = new PocketReconnectSignal();
        AtomicBoolean active = new AtomicBoolean(true);
        long observed = signal.currentGeneration();
        CountDownLatch started = new CountDownLatch(1);
        AtomicBoolean result = new AtomicBoolean(false);
        Thread waiter = new Thread(() -> {
            started.countDown();
            result.set(signal.awaitRetry(observed, 60_000L, active));
        });
        waiter.setDaemon(true);
        waiter.start();
        try {
            assertTrue(started.await(1, TimeUnit.SECONDS));
            signal.signal();
            waiter.join(1_000L);
            assertFalse("network signal must not leave the backoff thread waiting", waiter.isAlive());
            assertTrue(result.get());
            assertNotEquals(observed, signal.currentGeneration());
        } finally {
            active.set(false);
            signal.signal();
            waiter.join(1_000L);
        }
    }

    @Test
    public void stoppedMonitorNeverRetries() {
        PocketReconnectSignal signal = new PocketReconnectSignal();
        AtomicBoolean active = new AtomicBoolean(false);
        assertFalse(signal.awaitRetry(signal.currentGeneration(), 60_000L, active));
    }
}
