import { AuthChain, AuthLinkType, Entity, EntityType } from '@dcl/schemas'
import { createPartialDeploymentsComponent } from '../../src/logic/partial-deployments'
import { createCoordinatesComponent } from '../../src/logic/coordinates'
import { DeploymentFile } from '../../src/types'
import { PendingScene } from '../../src/adapters/pending-scenes-manager'

type PartialDeploymentsComponents = Parameters<typeof createPartialDeploymentsComponent>[0]

describe('partial deployments component', () => {
  let entityId: string
  let uploadedHash: string
  let siblingHash: string
  let entity: Entity
  let authChain: AuthChain
  let uploadedFile: DeploymentFile
  let files: Map<string, DeploymentFile>
  let pendingRow: PendingScene
  let fileInfoMultiple: jest.Mock
  let existMultiple: jest.Mock
  let storeStream: jest.Mock
  let validateStaging: jest.Mock
  let validate: jest.Mock
  let deployEntity: jest.Mock
  let components: PartialDeploymentsComponents

  beforeEach(() => {
    entityId = 'bafkreientity'
    uploadedHash = 'bafkreiuploaded'
    siblingHash = 'bafkreisibling'
    entity = {
      version: 'v3',
      id: entityId,
      type: EntityType.SCENE,
      timestamp: Date.now(),
      pointers: ['0,0'],
      content: [
        { file: 'uploaded.bin', hash: uploadedHash },
        { file: 'sibling.bin', hash: siblingHash }
      ],
      metadata: { worldConfiguration: { name: 'world.dcl.eth' }, scene: { base: '0,0', parcels: ['0,0'] } }
    }
    authChain = [{ type: AuthLinkType.SIGNER, payload: '0xdeployer', signature: '' }]
    uploadedFile = {
      size: 300,
      getStream: jest.fn(),
      getHash: jest.fn().mockResolvedValue(uploadedHash),
      asBuffer: jest.fn().mockResolvedValue(Buffer.from('x'))
    }
    files = new Map([[uploadedHash, uploadedFile]])
    pendingRow = {
      entityId,
      worldName: 'world.dcl.eth',
      parcels: ['0,0'],
      deployer: '0xdeployer',
      createdAt: new Date(),
      updatedAt: new Date()
    }

    // Start-of-request snapshot: nothing stored yet. Completeness check: a sibling request stored
    // siblingHash (500 bytes) in the meantime and this request stored uploadedHash (300 bytes).
    fileInfoMultiple = jest
      .fn()
      .mockResolvedValueOnce(
        new Map([
          [uploadedHash, undefined],
          [siblingHash, undefined]
        ])
      )
      .mockResolvedValueOnce(
        new Map([
          [uploadedHash, { size: 300 }],
          [siblingHash, { size: 500 }]
        ])
      )
    existMultiple = jest.fn().mockResolvedValue(
      new Map([
        [uploadedHash, true],
        [siblingHash, true]
      ])
    )
    storeStream = jest.fn().mockResolvedValue(undefined)
    validateStaging = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    validate = jest.fn().mockResolvedValue({ ok: () => true, errors: [] })
    deployEntity = jest.fn().mockResolvedValue({ message: 'deployed' })

    components = {
      config: { getNumber: jest.fn().mockResolvedValue(undefined) },
      coordinates: createCoordinatesComponent(),
      entityDeployer: { deployEntity },
      limitsManager: { getMaxAllowedSizeInBytesFor: jest.fn().mockResolvedValue(10_000n) },
      logs: {
        getLogger: jest.fn().mockReturnValue({ debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() })
      },
      pendingScenesManager: {
        getByEntityId: jest.fn().mockResolvedValue(undefined),
        upsert: jest.fn().mockResolvedValue(pendingRow),
        deleteByEntityId: jest.fn().mockResolvedValue(undefined)
      },
      storage: { fileInfoMultiple, existMultiple, storeStream },
      validator: { validateStaging, validate },
      worldsManager: { hasNewerDeployedScene: jest.fn().mockResolvedValue(false), getWorldScenes: jest.fn() }
    } as unknown as PartialDeploymentsComponents
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when a finalizing request completes a content set partly stored by sibling requests', () => {
    let deployedSize: number
    let complete: boolean

    beforeEach(async () => {
      const partialDeployments = await createPartialDeploymentsComponent(components)
      const result = await partialDeployments.stage({
        baseUrl: 'https://worlds.example',
        entity,
        entityRaw: JSON.stringify(entity),
        authChain,
        files
      })
      complete = result.complete
      deployedSize = deployEntity.mock.calls[0][6]
    })

    it('should persist the size from fresh completeness metadata instead of the start-of-request snapshot', () => {
      // The request-local budget estimate would count the sibling-stored file as 0 (absent from the
      // start snapshot) and persist 300; the fresh metadata yields the true 800.
      expect({ complete, deployedSize }).toEqual({ complete: true, deployedSize: 800 })
    })

    it('should hand the full validation the fresh metadata snapshot', () => {
      expect(validate.mock.calls[0][0].contentFileInfos).toEqual(
        new Map([
          [uploadedHash, { size: 300 }],
          [siblingHash, { size: 500 }]
        ])
      )
    })
  })

  describe('when the staging request carries an abort signal and a deadline', () => {
    let signal: AbortSignal
    let deadlineAt: number

    beforeEach(async () => {
      signal = new AbortController().signal
      deadlineAt = Date.now() + 60_000
      const partialDeployments = await createPartialDeploymentsComponent(components)
      await partialDeployments.stage({
        baseUrl: 'https://worlds.example',
        entity,
        entityRaw: JSON.stringify(entity),
        authChain,
        files,
        signal,
        deadlineAt
      })
    })

    it('should thread the signal into the staging validation and both signal and deadline into the finalize deploy', () => {
      expect({
        stagingSignal: validateStaging.mock.calls[0][0].signal,
        deploySignal: deployEntity.mock.calls[0][7],
        deployDeadlineAt: deployEntity.mock.calls[0][8]
      }).toEqual({ stagingSignal: signal, deploySignal: signal, deployDeadlineAt: deadlineAt })
    })
  })

  describe('when the staging request arrives with an already-aborted signal', () => {
    let abortReason: Error
    let caughtError: unknown

    beforeEach(async () => {
      abortReason = new Error('Client disconnected.')
      const controller = new AbortController()
      controller.abort(abortReason)
      const partialDeployments = await createPartialDeploymentsComponent(components)
      caughtError = await partialDeployments
        .stage({
          baseUrl: 'https://worlds.example',
          entity,
          entityRaw: JSON.stringify(entity),
          authChain,
          files,
          signal: controller.signal
        })
        .catch((error) => error)
    })

    it('should reject with the abort reason without storing files or deploying', () => {
      expect({
        caughtError,
        stores: storeStream.mock.calls.length,
        deployments: deployEntity.mock.calls.length
      }).toEqual({ caughtError: abortReason, stores: 0, deployments: 0 })
    })
  })
})
