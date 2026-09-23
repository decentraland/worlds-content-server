import { AuthLinkType, EntityType } from '@dcl/schemas'
import { createPartialDeploymentsComponent } from '../../src/logic/partial-deployments'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { createDeploymentProcessingMock } from '../mocks/deployment-processing-mock'
import { DeploymentToValidate } from '../../src/types'
import { StageDeploymentInput } from '../../src/logic/partial-deployments/types'

type Components = Parameters<typeof createPartialDeploymentsComponent>[0]

describe('when staging a partial deployment', () => {
  let components: Components
  let input: StageDeploymentInput
  let fileInfo: jest.Mock
  let getProgress: jest.Mock
  let getPending: jest.Mock
  let reserve: jest.Mock
  let storeStream: jest.Mock
  let validateStaging: jest.Mock
  let validate: jest.Mock
  let deployEntity: jest.Mock
  let stage: Awaited<ReturnType<typeof createPartialDeploymentsComponent>>['stage']

  beforeEach(async () => {
    input = {
      baseUrl: 'https://worlds.example',
      entityRaw: '{}',
      entity: {
        version: 'v3',
        id: 'entity',
        type: EntityType.SCENE,
        timestamp: Date.now(),
        pointers: ['0,0'],
        content: [
          { file: 'a', hash: 'a' },
          { file: 'b', hash: 'b' }
        ],
        metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { base: '0,0', parcels: ['0,0'] } }
      },
      authChain: [{ type: AuthLinkType.SIGNER, payload: 'deployer', signature: '' }],
      files: new Map([['a', { size: 300, getStream: jest.fn(), getHash: jest.fn(), asBuffer: jest.fn() }]])
    }
    fileInfo = jest.fn().mockResolvedValue(undefined)
    getProgress = jest.fn().mockResolvedValue(new Map([['a', 300]]))
    getPending = jest.fn().mockResolvedValue(undefined)
    reserve = jest.fn().mockResolvedValue(undefined)
    storeStream = jest.fn().mockResolvedValue(undefined)
    validateStaging = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    validate = jest.fn(async (deployment: DeploymentToValidate) => {
      deployment.sceneReplacementAuthorization = { mode: 'unrestricted-owner' }
      return { ok: () => true, errors: [] }
    })
    deployEntity = jest.fn().mockResolvedValue({ message: 'deployed', creationTimestamp: 123 })
    components = {
      config: { getNumber: jest.fn().mockResolvedValue(undefined) },
      coordinates: createCoordinatesComponent(),
      deploymentProcessing: createDeploymentProcessingMock(),
      entityDeployer: { deployEntity },
      limitsManager: { getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(10000n) },
      logs: { getLogger: jest.fn() },
      metrics: { increment: jest.fn() },
      pendingScenesManager: {
        getByEntityId: getPending,
        upsert: jest.fn().mockResolvedValue({ createdAt: new Date() }),
        reserve,
        recordStored: jest.fn(),
        getProgress,
        markMissing: jest.fn(),
        getCompleted: jest.fn().mockResolvedValue({ creationTimestamp: 123 })
      },
      storage: { fileInfo, storeStream },
      validator: { validateStaging, validate },
      worldsManager: { hasNewerDeployedScene: jest.fn().mockResolvedValue(false) }
    } as unknown as Components
    ;({ stage } = await createPartialDeploymentsComponent(components))
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and validation rejects the manifest', () => {
    beforeEach(() => {
      validateStaging.mockResolvedValueOnce({ ok: () => false, errors: ['invalid manifest'] })
    })
    it('should reject before looking up storage or reserving bytes', async () => {
      await expect(stage(input)).rejects.toThrow('invalid manifest')
      expect({ metadata: fileInfo.mock.calls.length, reservations: reserve.mock.calls.length }).toEqual({
        metadata: 0,
        reservations: 0
      })
    })
  })

  describe('and a resumed batch is still incomplete', () => {
    beforeEach(() => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
    })
    it('should report missing hashes without querying storage metadata', async () => {
      expect(await stage(input)).toEqual({ complete: false, missing: ['b'] })
      expect(fileInfo).not.toHaveBeenCalled()
    })
  })

  describe('and the staging budget is exhausted', () => {
    beforeEach(() => {
      reserve.mockRejectedValueOnce(new Error('budget exceeded'))
    })
    it('should reject before any storage write', async () => {
      await expect(stage(input)).rejects.toThrow('budget exceeded')
      expect(storeStream).not.toHaveBeenCalled()
    })
  })

  describe('and a resumed batch completes the manifest', () => {
    beforeEach(() => {
      getPending.mockResolvedValueOnce({ createdAt: new Date(), deployer: 'deployer', initialized: true })
      getProgress.mockResolvedValueOnce(
        new Map([
          ['a', 300],
          ['b', 500]
        ])
      )
      fileInfo.mockImplementation(async (hash) => ({ size: hash === 'a' ? 300 : 500 }))
      input.signal = new AbortController().signal
      input.deadlineAt = Date.now() + 60000
    })
    it('should persist verified total size and preserve the completion timestamp', async () => {
      expect(await stage(input)).toEqual({
        complete: true,
        result: { message: 'deployed', creationTimestamp: 123 },
        creationTimestamp: 123
      })
      expect(deployEntity.mock.calls[0].slice(6, 9)).toEqual([800, input.signal, input.deadlineAt])
    })
    it('should perform only one final metadata pass', async () => {
      await stage(input)
      expect(fileInfo.mock.calls.map(([hash]) => hash)).toEqual(['a', 'b'])
    })
    it('should pass the request signal into storage writes', async () => {
      await stage(input)
      expect(storeStream.mock.calls[0][2]).toBe(input.signal)
    })
    describe('and storage has lost a previously acknowledged file', () => {
      beforeEach(() => {
        fileInfo.mockResolvedValueOnce(undefined)
      })
      it('should invalidate its receipt and request that file again', async () => {
        expect(await stage(input)).toEqual({ complete: false, missing: ['a'] })
        expect(components.pendingScenesManager.markMissing).toHaveBeenCalledWith('entity', ['a'], input.signal)
        expect(deployEntity).not.toHaveBeenCalled()
      })
    })
  })

  describe('and the request is already cancelled', () => {
    beforeEach(() => {
      input.signal = AbortSignal.abort(new Error('cancelled'))
    })
    it('should reject without looking up pending state', async () => {
      await expect(stage(input)).rejects.toThrow('cancelled')
      expect(getPending).not.toHaveBeenCalled()
    })
  })
})
