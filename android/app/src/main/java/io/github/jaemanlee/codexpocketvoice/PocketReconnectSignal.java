package io.github.jaemanlee.codexpocketvoice;

import java.util.concurrent.atomic.AtomicBoolean;

final class PocketReconnectSignal {
    private long generation;

    synchronized long currentGeneration() {
        return generation;
    }

    synchronized void signal() {
        generation += 1;
        notifyAll();
    }

    synchronized boolean awaitRetry(long observedGeneration, long timeoutMs, AtomicBoolean active) {
        if (!active.get()) return false;
        long remainingNanos = Math.max(0L, timeoutMs) * 1_000_000L;
        long deadline = System.nanoTime() + remainingNanos;
        while (active.get() && generation == observedGeneration && remainingNanos > 0L) {
            long milliseconds = remainingNanos / 1_000_000L;
            int nanoseconds = (int) (remainingNanos % 1_000_000L);
            try {
                wait(milliseconds, nanoseconds);
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                return false;
            }
            remainingNanos = deadline - System.nanoTime();
        }
        return active.get();
    }
}
