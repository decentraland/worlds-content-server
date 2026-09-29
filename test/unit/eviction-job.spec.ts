import { createEvictionJob } from '../../src/adapters/eviction-job'
import { createMockWorlds } from '../mocks/worlds-mock'
import { createMockedConfig } from '../mocks/config-mock'
import { IWorldsComponent } from '../../src/logic/worlds/types'
import { IConfigComponent, ILoggerComponent } from '@well-known-components/interfaces'
import { createJobComponent } from '@dcl/job-component'

jest.mock('@dcl/job-component', () => ({
  createJobComponent: jest.fn().mockReturnValue({
    start: jest.fn(),
    stop: jest.fn()
  })
}))

const mockCreateJobComponent = createJobComponent as jest.Mock

describe('EvictionJob', () => {
  let worlds: jest.Mocked<IWorldsComponent>
  let logs: ILoggerComponent

  beforeEach(() => {
    worlds = createMockWorlds()
    worlds.evictUndeployedWorlds.mockResolvedValue(0)
    logs = {
      getLogger: () => ({
        log: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
      })
    }
    mockCreateJobComponent.mockClear()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when SCENE_EVICTION_TTL_MS is configured', () => {
    let config: jest.Mocked<IConfigComponent>
    let jobCallback: () => Promise<void>

    beforeEach(async () => {
      config = createMockedConfig({ getNumber: jest.fn().mockResolvedValue(3600000) })
      await createEvictionJob({ config, logs, worlds })
      jobCallback = mockCreateJobComponent.mock.calls[0][1]
    })

    it('should create the job component', () => {
      expect(mockCreateJobComponent).toHaveBeenCalled()
    })

    describe('and the job callback is invoked', () => {
      beforeEach(async () => {
        worlds.evictUndeployedWorlds.mockResolvedValueOnce(3)
        await jobCallback()
      })

      it('should call evictUndeployedWorlds with the configured TTL', () => {
        expect(worlds.evictUndeployedWorlds).toHaveBeenCalledWith(3600000)
      })
    })
  })

  describe('when SCENE_EVICTION_TTL_MS is not configured', () => {
    let config: jest.Mocked<IConfigComponent>
    let jobCallback: () => Promise<void>

    beforeEach(async () => {
      config = createMockedConfig({ getNumber: jest.fn().mockResolvedValue(undefined) })
      await createEvictionJob({ config, logs, worlds })
      jobCallback = mockCreateJobComponent.mock.calls[0][1]
    })

    it('should create the job component', () => {
      expect(mockCreateJobComponent).toHaveBeenCalled()
    })

    describe('and the job callback is invoked', () => {
      beforeEach(async () => {
        await jobCallback()
      })

      it('should call evictUndeployedWorlds with the default 7-day TTL', () => {
        expect(worlds.evictUndeployedWorlds).toHaveBeenCalledWith(7 * 24 * 60 * 60 * 1000)
      })
    })
  })
})
