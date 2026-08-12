/**
 * A 4xx from the comms-gatekeeper is a permanent contract or auth failure — a wrong bearer
 * token, a route that does not exist yet. Retrying only multiplies load on every connection and
 * buries the cause under transient-looking retry warnings.
 */
export class PermanentGatekeeperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PermanentGatekeeperError'
  }
}
