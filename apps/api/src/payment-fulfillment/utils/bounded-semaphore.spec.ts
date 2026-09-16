import { HttpStatus } from '@nestjs/common';
import {
  BoundedSemaphore,
  AdmissionTimeoutException,
  AdmissionQueueFullException,
} from './bounded-semaphore';

describe('BoundedSemaphore', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  describe('Constructor & Parameter Validation', () => {
    it('initializes successfully with valid positive integer limits', () => {
      const semaphore = new BoundedSemaphore(5, 10, 1000);
      expect(semaphore.activeLimit).toBe(5);
      expect(semaphore.queueLimit).toBe(10);
      expect(semaphore.timeoutMs).toBe(1000);
      expect(semaphore.activeCount).toBe(0);
      expect(semaphore.waitingCount).toBe(0);
    });

    describe('activeLimit validation', () => {
      it.each([0, -1, -100])('rejects non-positive activeLimit: %p', (val) => {
        expect(() => new BoundedSemaphore(val, 10, 1000)).toThrow(
          /activeLimit must be a positive bounded integer/,
        );
      });

      it.each([1.5, NaN, Infinity, -Infinity])('rejects non-integer/infinite activeLimit: %p', (val) => {
        expect(() => new BoundedSemaphore(val, 10, 1000)).toThrow(
          /activeLimit must be a positive bounded integer/,
        );
      });

      it.each([null, undefined, '5'])('rejects non-number activeLimit: %p', (val: any) => {
        expect(() => new BoundedSemaphore(val, 10, 1000)).toThrow(
          /activeLimit must be a positive bounded integer/,
        );
      });
    });

    describe('queueLimit validation', () => {
      it.each([0, -1, -50])('rejects non-positive queueLimit: %p', (val) => {
        expect(() => new BoundedSemaphore(5, val, 1000)).toThrow(
          /queueLimit must be a positive bounded integer/,
        );
      });

      it.each([2.5, NaN, Infinity, -Infinity])('rejects non-integer/infinite queueLimit: %p', (val) => {
        expect(() => new BoundedSemaphore(5, val, 1000)).toThrow(
          /queueLimit must be a positive bounded integer/,
        );
      });

      it.each([null, undefined, '10'])('rejects non-number queueLimit: %p', (val: any) => {
        expect(() => new BoundedSemaphore(5, val, 1000)).toThrow(
          /queueLimit must be a positive bounded integer/,
        );
      });
    });

    describe('timeoutMs validation', () => {
      it.each([0, -1, -5000])('rejects non-positive timeoutMs: %p', (val) => {
        expect(() => new BoundedSemaphore(5, 10, val)).toThrow(
          /timeoutMs must be a positive bounded integer/,
        );
      });

      it.each([100.5, NaN, Infinity, -Infinity])('rejects non-integer/infinite timeoutMs: %p', (val) => {
        expect(() => new BoundedSemaphore(5, 10, val)).toThrow(
          /timeoutMs must be a positive bounded integer/,
        );
      });

      it.each([null, undefined, '1000'])('rejects non-number timeoutMs: %p', (val: any) => {
        expect(() => new BoundedSemaphore(5, 10, val)).toThrow(
          /timeoutMs must be a positive bounded integer/,
        );
      });
    });
  });

  describe('Immediate Acquisition', () => {
    it('grants permits immediately up to activeLimit without queuing', async () => {
      const semaphore = new BoundedSemaphore(3, 5, 1000);

      const release1 = await semaphore.acquire();
      expect(typeof release1).toBe('function');
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(0);

      const release2 = await semaphore.acquire();
      expect(typeof release2).toBe('function');
      expect(semaphore.activeCount).toBe(2);
      expect(semaphore.waitingCount).toBe(0);

      const release3 = await semaphore.acquire();
      expect(typeof release3).toBe('function');
      expect(semaphore.activeCount).toBe(3);
      expect(semaphore.waitingCount).toBe(0);

      release1();
      expect(semaphore.activeCount).toBe(2);
      release2();
      expect(semaphore.activeCount).toBe(1);
      release3();
      expect(semaphore.activeCount).toBe(0);
    });
  });

  describe('FIFO Queuing & Release Order', () => {
    it('queues callers when activeLimit is reached and grants permits in FIFO order upon release', async () => {
      const semaphore = new BoundedSemaphore(1, 3, 5000);

      const release1 = await semaphore.acquire();
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(0);

      const executionOrder: string[] = [];

      const promise2 = semaphore.acquire().then((release) => {
        executionOrder.push('p2');
        return release;
      });
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(1);

      const promise3 = semaphore.acquire().then((release) => {
        executionOrder.push('p3');
        return release;
      });
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(2);

      expect(executionOrder).toEqual([]);

      // Release holder 1 -> p2 should be granted permit
      release1();
      const release2 = await promise2;
      expect(executionOrder).toEqual(['p2']);
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(1);

      // Release holder 2 -> p3 should be granted permit
      release2();
      const release3 = await promise3;
      expect(executionOrder).toEqual(['p2', 'p3']);
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(0);

      // Release holder 3 -> activeCount decrements to 0
      release3();
      expect(semaphore.activeCount).toBe(0);
      expect(semaphore.waitingCount).toBe(0);
    });
  });

  describe('Queue Limit Overflow', () => {
    it('rejects immediately with AdmissionQueueFullException when queueLimit is reached', async () => {
      const semaphore = new BoundedSemaphore(1, 2, 5000);

      const release1 = await semaphore.acquire();
      expect(semaphore.activeCount).toBe(1);

      const queued1 = semaphore.acquire();
      const queued2 = semaphore.acquire();
      expect(semaphore.waitingCount).toBe(2);

      // 3rd waiter exceeds queueLimit (2)
      await expect(semaphore.acquire()).rejects.toThrow(AdmissionQueueFullException);
      await expect(semaphore.acquire()).rejects.toMatchObject({
        status: HttpStatus.TOO_MANY_REQUESTS,
        message: 'Admission queue limit exceeded',
      });

      // Active and waiting counts remain unchanged
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(2);

      // Clean up queued
      release1();
      const releaseQ1 = await queued1;
      releaseQ1();
      const releaseQ2 = await queued2;
      releaseQ2();
      expect(semaphore.activeCount).toBe(0);
      expect(semaphore.waitingCount).toBe(0);
    });
  });

  describe('Timeout Handling', () => {
    it('rejects with AdmissionTimeoutException when queued request exceeds timeoutMs', async () => {
      jest.useFakeTimers();
      const semaphore = new BoundedSemaphore(1, 2, 2000);

      const release1 = await semaphore.acquire();

      let timeoutError: any;
      const waiterPromise = semaphore.acquire().catch((err) => {
        timeoutError = err;
      });

      expect(semaphore.waitingCount).toBe(1);

      // Advance time past timeout
      jest.advanceTimersByTime(2000);
      await Promise.resolve(); // flush microtasks

      await waiterPromise;
      expect(timeoutError).toBeInstanceOf(AdmissionTimeoutException);
      expect(timeoutError.getStatus()).toBe(HttpStatus.GATEWAY_TIMEOUT);
      expect(timeoutError.message).toBe('Admission queue timeout exceeded');

      // Waiter was removed from queue
      expect(semaphore.waitingCount).toBe(0);
      expect(semaphore.activeCount).toBe(1);

      // Releasing permit 1 after waiter timeout decrements activeCount
      release1();
      expect(semaphore.activeCount).toBe(0);
    });

    it('removes timed-out waiter so subsequent waiter in queue receives the permit', async () => {
      jest.useFakeTimers();
      const semaphore = new BoundedSemaphore(1, 3, 2000);

      const release1 = await semaphore.acquire();

      let waiter1Error: any;
      const waiter1Promise = semaphore.acquire().catch((err) => {
        waiter1Error = err;
      });

      expect(semaphore.waitingCount).toBe(1);

      // Advance by 1000ms, then queue waiter 2
      jest.advanceTimersByTime(1000);

      let waiter2Acquired = false;
      let release2: (() => void) | undefined;
      const waiter2Promise = semaphore.acquire().then((rel) => {
        waiter2Acquired = true;
        release2 = rel;
      });

      expect(semaphore.waitingCount).toBe(2);

      // Advance another 1000ms (total 2000ms from t=0): waiter 1 times out (at 2000ms), waiter 2 has waited only 1000ms
      jest.advanceTimersByTime(1000);
      await Promise.resolve();

      await waiter1Promise;
      expect(waiter1Error).toBeInstanceOf(AdmissionTimeoutException);
      expect(waiter2Acquired).toBe(false);
      expect(semaphore.waitingCount).toBe(1);

      // Release holder 1: waiter 2 is next in queue and should receive the permit
      release1();
      await Promise.resolve();
      await waiter2Promise;

      expect(waiter2Acquired).toBe(true);
      expect(semaphore.waitingCount).toBe(0);
      expect(semaphore.activeCount).toBe(1);

      release2!();
      expect(semaphore.activeCount).toBe(0);
    });

    it('clears timer when permit is granted before timeout', async () => {
      jest.useFakeTimers();
      const semaphore = new BoundedSemaphore(1, 2, 5000);

      const release1 = await semaphore.acquire();

      let acquired = false;
      let release2: (() => void) | undefined;
      const waiterPromise = semaphore.acquire().then((rel) => {
        acquired = true;
        release2 = rel;
      });

      // Advance time by 2000ms (less than 5000ms)
      jest.advanceTimersByTime(2000);
      expect(acquired).toBe(false);

      // Release holder 1: waiter acquires permit
      release1();
      await Promise.resolve();
      await waiterPromise;
      expect(acquired).toBe(true);
      expect(semaphore.activeCount).toBe(1);
      expect(semaphore.waitingCount).toBe(0);

      // Advance time past original 5000ms timeout (e.g. another 4000ms, total 6000ms)
      jest.advanceTimersByTime(4000);
      await Promise.resolve();

      // Permit is still valid and activeCount is still 1 (timer did not fire)
      expect(semaphore.activeCount).toBe(1);
      release2!();
      expect(semaphore.activeCount).toBe(0);
    });

    it('allows new waiter to join queue after timed-out waiter vacates queue slot', async () => {
      jest.useFakeTimers();
      const semaphore = new BoundedSemaphore(1, 1, 1000);

      const release1 = await semaphore.acquire();

      // Fill the 1 queue slot
      const waiter1 = semaphore.acquire().catch(() => {});
      expect(semaphore.waitingCount).toBe(1);

      // Next would fail immediately with queue full
      await expect(semaphore.acquire()).rejects.toThrow(AdmissionQueueFullException);

      // Advance time so waiter1 times out
      jest.advanceTimersByTime(1000);
      await Promise.resolve();
      await waiter1;

      expect(semaphore.waitingCount).toBe(0);

      // Now a new waiter can enter the queue without throwing AdmissionQueueFullException
      let waiter2Acquired = false;
      const waiter2 = semaphore.acquire().then((rel) => {
        waiter2Acquired = true;
        return rel;
      });
      expect(semaphore.waitingCount).toBe(1);

      // Release first holder -> waiter 2 acquires
      release1();
      await Promise.resolve();
      const release2 = await waiter2;
      expect(waiter2Acquired).toBe(true);
      expect(semaphore.waitingCount).toBe(0);
      expect(semaphore.activeCount).toBe(1);

      release2();
      expect(semaphore.activeCount).toBe(0);
    });
  });

  describe('Release Idempotency', () => {
    it('calling release multiple times does not decrement activeCount multiple times', async () => {
      const semaphore = new BoundedSemaphore(2, 2, 1000);

      const release1 = await semaphore.acquire();
      expect(semaphore.activeCount).toBe(1);

      release1();
      expect(semaphore.activeCount).toBe(0);

      // Idempotent secondary calls
      release1();
      release1();
      expect(semaphore.activeCount).toBe(0);
    });

    it('calling release multiple times does not release multiple queued waiters', async () => {
      const semaphore = new BoundedSemaphore(1, 2, 5000);

      const release1 = await semaphore.acquire();

      let waiter1Resolved = false;
      let waiter2Resolved = false;

      const p1 = semaphore.acquire().then((rel) => {
        waiter1Resolved = true;
        return rel;
      });
      const p2 = semaphore.acquire().then((rel) => {
        waiter2Resolved = true;
        return rel;
      });

      expect(semaphore.waitingCount).toBe(2);

      // Call release1 once
      release1();
      const releaseWaiter1 = await p1;
      expect(waiter1Resolved).toBe(true);
      expect(waiter2Resolved).toBe(false);
      expect(semaphore.waitingCount).toBe(1);
      expect(semaphore.activeCount).toBe(1);

      // Call release1 multiple extra times
      release1();
      release1();
      expect(waiter2Resolved).toBe(false);
      expect(semaphore.waitingCount).toBe(1);
      expect(semaphore.activeCount).toBe(1);

      // Call release on waiter1 to resolve waiter2
      releaseWaiter1();
      const releaseWaiter2 = await p2;
      expect(waiter2Resolved).toBe(true);
      expect(semaphore.waitingCount).toBe(0);
      expect(semaphore.activeCount).toBe(1);

      releaseWaiter2();
      expect(semaphore.activeCount).toBe(0);
    });
  });
});
