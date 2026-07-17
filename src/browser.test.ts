import { describe, expect, test } from "bun:test";
import { WheelBurstGuard } from "./browser.ts";

describe("WheelBurstGuard", () => {
    test("disarmed guard drops nothing", () => {
        const guard = new WheelBurstGuard(250);
        expect(guard.shouldDrop(1000)).toBe(false);
        expect(guard.shouldDrop(1001)).toBe(false);
    });

    test("drops a wheel-momentum burst right after arming", () => {
        const guard = new WheelBurstGuard(250);
        guard.arm(1000);
        // Alternate-scroll wheel ticks: 3 arrows nearly at once, then decaying.
        expect(guard.shouldDrop(1005)).toBe(true);
        expect(guard.shouldDrop(1006)).toBe(true);
        expect(guard.shouldDrop(1007)).toBe(true);
        expect(guard.shouldDrop(1080)).toBe(true);
        expect(guard.shouldDrop(1200)).toBe(true);
    });

    test("first arrow after a quiet gap disarms and is handled", () => {
        const guard = new WheelBurstGuard(250);
        guard.arm(1000);
        expect(guard.shouldDrop(1050)).toBe(true);
        // Momentum died out; a real keystroke arrives later.
        expect(guard.shouldDrop(1400)).toBe(false);
        // Guard is now off — even rapid keyboard repeat goes through.
        expect(guard.shouldDrop(1420)).toBe(false);
        expect(guard.shouldDrop(1440)).toBe(false);
    });

    test("keystroke long after arming goes straight through", () => {
        const guard = new WheelBurstGuard(250);
        guard.arm(1000);
        expect(guard.shouldDrop(2000)).toBe(false);
    });

    test("re-arming re-enables the guard", () => {
        const guard = new WheelBurstGuard(250);
        guard.arm(1000);
        expect(guard.shouldDrop(2000)).toBe(false);
        guard.arm(3000);
        expect(guard.shouldDrop(3010)).toBe(true);
    });
});
