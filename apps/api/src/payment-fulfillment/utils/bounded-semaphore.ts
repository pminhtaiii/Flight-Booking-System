import { HttpException, HttpStatus } from '@nestjs/common';

export class AdmissionTimeoutException extends HttpException {
  constructor(message = 'Admission queue timeout exceeded') {
    super(message, HttpStatus.GATEWAY_TIMEOUT);
  }
}

export class AdmissionQueueFullException extends HttpException {
  constructor(message = 'Admission queue limit exceeded') {
    super(message, HttpStatus.TOO_MANY_REQUESTS);
  }
}

interface Waiter {
  resolve: (release: () => void) => void;
  reject: (err: unknown) => void;
  timer: NodeJS.Timeout | null;
}

function validatePositiveBoundedInteger(val: unknown, name: string): asserts val is number {
  if (
    typeof val !== 'number' ||
    !Number.isInteger(val) ||
    !Number.isFinite(val) ||
    val <= 0
  ) {
    throw new Error(`${name} must be a positive bounded integer`);
  }
}

export function parsePositiveIntegerSetting(
  rawValue: string | undefined,
  defaultValue: number,
  varName: string,
): number {
  if (rawValue === undefined || rawValue === '') {
    return defaultValue;
  }
  const trimmed = rawValue.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) {
    throw new Error(
      `Invalid configuration for ${varName}: "${rawValue}". Must be a positive integer string.`,
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid configuration for ${varName}: "${rawValue}". Must be a safe positive integer.`,
    );
  }
  return parsed;
}

export class BoundedSemaphore {
  private readonly _activeLimit: number;
  private readonly _queueLimit: number;
  private readonly _timeoutMs: number;

  private _activeCount = 0;
  private readonly _queue: Waiter[] = [];

  constructor(activeLimit: number, queueLimit: number, timeoutMs: number) {
    validatePositiveBoundedInteger(activeLimit, 'activeLimit');
    validatePositiveBoundedInteger(queueLimit, 'queueLimit');
    validatePositiveBoundedInteger(timeoutMs, 'timeoutMs');

    this._activeLimit = activeLimit;
    this._queueLimit = queueLimit;
    this._timeoutMs = timeoutMs;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get waitingCount(): number {
    return this._queue.length;
  }

  get activeLimit(): number {
    return this._activeLimit;
  }

  get queueLimit(): number {
    return this._queueLimit;
  }

  get timeoutMs(): number {
    return this._timeoutMs;
  }

  public acquire(): Promise<() => void> {
    if (this._activeCount < this._activeLimit) {
      this._activeCount++;
      return Promise.resolve(this.createReleaseCallback());
    }

    if (this._queue.length < this._queueLimit) {
      return new Promise<() => void>((resolve, reject) => {
        const waiter: Waiter = {
          resolve: (release: () => void) => {
            if (waiter.timer) {
              clearTimeout(waiter.timer);
              waiter.timer = null;
            }
            resolve(release);
          },
          reject: (err: unknown) => {
            if (waiter.timer) {
              clearTimeout(waiter.timer);
              waiter.timer = null;
            }
            reject(err);
          },
          timer: null,
        };

        const timer = setTimeout(() => {
          const index = this._queue.indexOf(waiter);
          if (index !== -1) {
            this._queue.splice(index, 1);
          }
          if (waiter.timer) {
            clearTimeout(waiter.timer);
            waiter.timer = null;
          }
          waiter.reject(new AdmissionTimeoutException());
        }, this._timeoutMs);

        waiter.timer = timer;

        this._queue.push(waiter);
      });
    }

    return Promise.reject(new AdmissionQueueFullException());
  }

  private createReleaseCallback(): () => void {
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;

      if (this._queue.length > 0) {
        const nextWaiter = this._queue.shift()!;
        nextWaiter.resolve(this.createReleaseCallback());
      } else {
        this._activeCount = Math.max(0, this._activeCount - 1);
      }
    };
  }
}
