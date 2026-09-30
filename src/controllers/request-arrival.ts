import { IHttpServerComponent } from '@dcl/core-commons'

/** A request context stamped with when the request arrived, before its body was read. */
export type RequestArrivalContext = { requestArrivedAt: number }

/**
 * Stamps the request with its arrival time, so time limits that start with a request (a partial
 * upload's lifetime and freshness) don't depend on how long its body took to arrive.
 * @returns Middleware to place before any body parsing.
 */
export function stampRequestArrival(): (
  context: object,
  next: () => Promise<IHttpServerComponent.IResponse>
) => Promise<IHttpServerComponent.IResponse> {
  return async (context, next) => {
    const arrival: RequestArrivalContext = { requestArrivedAt: Date.now() }
    Object.assign(context, arrival)
    return next()
  }
}

/**
 * Reads the arrival stamp of a request routed behind {@link stampRequestArrival}.
 * @param context Request context.
 * @returns Arrival time in epoch milliseconds.
 * @throws Error when the route did not stamp the request.
 */
export function getRequestArrival(context: object): number {
  const arrivedAt = (context as Partial<RequestArrivalContext>).requestArrivedAt
  if (typeof arrivedAt !== 'number') throw new Error('The request was not stamped with its arrival time')
  return arrivedAt
}
