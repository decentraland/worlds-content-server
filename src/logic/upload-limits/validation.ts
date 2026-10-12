/**
 * @param name Setting name used in the error.
 * @param value Value to check.
 * @throws Error when the value isn't a positive safe integer.
 */
export function validatePositiveByteLimit(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive safe integer, got ${value}`)
  }
}

/**
 * @param name Setting name used in the error.
 * @param value Value to check.
 * @throws Error when the value isn't a non-negative safe integer.
 */
export function validateReservationBytes(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer, got ${value}`)
  }
}
