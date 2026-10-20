import { getRequestArrival, stampRequestArrival } from '../../src/controllers/request-arrival'

describe('when reading the arrival time of a request', () => {
  let context: { requestArrivedAt?: number }

  describe('and the request was stamped on arrival', () => {
    let arrival: number

    beforeEach(async () => {
      jest.useFakeTimers({ now: 1_700_000_000_000 })
      context = {}
      await stampRequestArrival()(context, async () => ({ status: 200 }))
      jest.setSystemTime(1_700_000_005_000)
      arrival = getRequestArrival(context)
    })

    afterEach(() => {
      jest.useRealTimers()
    })

    it('should return the time the request arrived', () => {
      expect(arrival).toBe(1_700_000_000_000)
    })
  })

  describe('and the request was not stamped', () => {
    let read: () => number

    beforeEach(() => {
      context = {}
      read = () => getRequestArrival(context)
    })

    it('should throw', () => {
      expect(read).toThrow('The request was not stamped with its arrival time')
    })
  })
})
