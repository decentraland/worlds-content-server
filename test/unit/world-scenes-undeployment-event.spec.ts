import { buildWorldScenesUndeploymentEvent } from '../../src/logic/worlds/world-scenes-undeployment-event'

describe('when building a world scenes undeployment event', () => {
  describe('and every footprint fits the message budget', () => {
    let result: ReturnType<typeof buildWorldScenesUndeploymentEvent>

    beforeEach(() => {
      result = buildWorldScenesUndeploymentEvent(
        'example.dcl.eth',
        123,
        [
          { entityId: 'entity-a', baseParcel: '0,0', parcels: ['0,0', '1,0'] },
          { entityId: 'entity-b', baseParcel: '5,5', parcels: ['5,5'] }
        ],
        1024
      )
    })

    it('should include every scene footprint', () => {
      expect(result.event.metadata.scenes).toEqual([
        { entityId: 'entity-a', baseParcel: '0,0', parcels: ['0,0', '1,0'] },
        { entityId: 'entity-b', baseParcel: '5,5', parcels: ['5,5'] }
      ])
    })

    it('should report that no footprints were omitted', () => {
      expect(result.omittedFootprints).toBe(0)
    })
  })

  describe('and one footprint does not fit but a later one does', () => {
    let result: ReturnType<typeof buildWorldScenesUndeploymentEvent>
    let identityOnlySize: number

    beforeEach(() => {
      const scenes = [
        { entityId: 'entity-a', baseParcel: '0,0', parcels: Array.from({ length: 100 }, () => '0,0') },
        { entityId: 'entity-b', baseParcel: '5,5', parcels: ['5,5'] }
      ]
      const identityOnly = buildWorldScenesUndeploymentEvent('example.dcl.eth', 123, scenes, 1024)
      identityOnlySize = Buffer.byteLength(
        JSON.stringify({
          ...identityOnly.event,
          metadata: {
            ...identityOnly.event.metadata,
            scenes: identityOnly.event.metadata.scenes.map(({ entityId, baseParcel }) => ({ entityId, baseParcel }))
          }
        }),
        'utf8'
      )
      result = buildWorldScenesUndeploymentEvent('example.dcl.eth', 123, scenes, identityOnlySize + 25)
    })

    it('should preserve both scene identities while including only the smaller footprint', () => {
      expect(result.event.metadata.scenes).toEqual([
        { entityId: 'entity-a', baseParcel: '0,0' },
        { entityId: 'entity-b', baseParcel: '5,5', parcels: ['5,5'] }
      ])
    })

    it('should report the omitted footprint', () => {
      expect(result.omittedFootprints).toBe(1)
    })
  })

  describe('and scene identities alone exceed the message budget', () => {
    let build: () => ReturnType<typeof buildWorldScenesUndeploymentEvent>

    beforeEach(() => {
      build = () =>
        buildWorldScenesUndeploymentEvent(
          'example.dcl.eth',
          123,
          [{ entityId: 'entity-a', baseParcel: '0,0', parcels: ['0,0'] }],
          1
        )
    })

    it('should reject the event before publishing it', () => {
      expect(build).toThrow('exceeding the 1-byte SNS budget')
    })
  })
})
