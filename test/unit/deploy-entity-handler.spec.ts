import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import path from 'path'
import { deployEntity } from '../../src/controllers/handlers/deploy-entity-handler'
import { InvalidRequestError, NotAuthorizedError } from '@dcl/http-commons'

type DeployContext = Parameters<typeof deployEntity>[0]

describe('deployEntity', () => {
  const entityId = 'bafkreiahsvnr4x4rnskhkwfbnbplkbqhzb3xagdwpyfy44lgcndmhyizde'
  let tmpDir: string
  let fileCounter: number

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'deploy-entity-test-'))
    fileCounter = 0
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  function makeField(...value: string[]) {
    return {
      fieldname: 'field',
      value,
      nameTruncated: false,
      valueTruncated: false,
      encoding: '7bit',
      mimeType: 'text/plain'
    }
  }

  // Uploaded files are streamed to temp files, so the handler reads them by path. Write the
  // content to a temp file and return the metadata the multipart parser would have produced.
  function makeFile(content: Buffer) {
    const filepath = path.join(tmpDir, `file-${fileCounter++}`)
    writeFileSync(filepath, content)
    return {
      fieldname: 'file',
      filename: 'file',
      encoding: '7bit',
      mimeType: 'application/octet-stream',
      filepath,
      size: content.length
    }
  }

  /**
   * Builds a minimal multipart context with a valid entityId field and a single-link auth chain,
   * so the handler reaches the entity-file handling instead of failing earlier on a missing auth chain.
   */
  function createContext(id: string, files: Record<string, ReturnType<typeof makeFile>>): DeployContext {
    return {
      formData: {
        fields: {
          entityId: makeField(id),
          'authChain[0][payload]': makeField('0xpayload'),
          'authChain[0][signature]': makeField('0xsignature'),
          'authChain[0][type]': makeField('SIGNER')
        },
        files
      }
    } as unknown as DeployContext
  }

  describe('when the entity file referenced by entityId is missing from the request', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, {})
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      const error = await deployEntity(context).catch((e) => e)

      expect(error).toBeInstanceOf(InvalidRequestError)
      expect(error.message).toBe(`Entity file "${entityId}" is missing from the request.`)
    })
  })

  describe('when the entity file is not valid JSON', () => {
    let context: DeployContext

    beforeEach(() => {
      context = createContext(entityId, { [entityId]: makeFile(Buffer.from('this is not json')) })
    })

    it('should reject with an InvalidRequestError instead of crashing', async () => {
      const error = await deployEntity(context).catch((e) => e)

      expect(error).toBeInstanceOf(InvalidRequestError)
      expect(error.message).toBe('The entity file is not valid JSON.')
    })
  })

  describe('when deploying a world scene with ?single_world_scene=true', () => {
    const worldEntityJson = JSON.stringify({
      type: 'scene',
      pointers: ['0,0'],
      timestamp: 1,
      content: [],
      metadata: {
        worldConfiguration: { name: 'test-world' },
        scene: { base: '0,0', parcels: ['0,0'] }
      }
    })

    // Builds a full deploy context that reaches the singleWorldScene branch: validation passes, the
    // entity deploys, and the permission checks resolve per the given options.
    function createSingleSceneContext(opts: {
      isOwner: boolean
      hasWorldWide: boolean
      singleWorldScene?: boolean
      entityJson?: string
    }) {
      const deployEntityFn = jest.fn().mockResolvedValue({})
      const undeployOtherWorldScenes = jest.fn().mockResolvedValue(undefined)
      const checkPermission = jest.fn().mockResolvedValue(opts.isOwner)
      const base = createContext(entityId, { [entityId]: makeFile(Buffer.from(opts.entityJson ?? worldEntityJson)) })
      const searchParams = new URLSearchParams((opts.singleWorldScene ?? true) ? 'single_world_scene=true' : '')

      const context = {
        ...base,
        url: { host: 'localhost', searchParams },
        components: {
          config: { getString: jest.fn().mockResolvedValue('https://worlds-content-server.decentraland.org') },
          logs: {
            getLogger: () => ({ warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn(), log: jest.fn() })
          },
          storage: { existMultiple: jest.fn().mockResolvedValue({}) },
          validator: { validate: jest.fn().mockResolvedValue({ ok: () => true, errors: [] }) },
          entityDeployer: { deployEntity: deployEntityFn },
          namePermissionChecker: { checkPermission },
          permissions: { hasWorldWidePermission: jest.fn().mockResolvedValue(opts.hasWorldWide) },
          worlds: { undeployOtherWorldScenes }
        }
      } as unknown as DeployContext

      return { context, deployEntityFn, undeployOtherWorldScenes, checkPermission }
    }

    describe('and the deployer owns the world', () => {
      it('should deploy the scene and then undeploy every other scene, keeping the deployed scene by entity id', async () => {
        const { context, deployEntityFn, undeployOtherWorldScenes } = createSingleSceneContext({
          isOwner: true,
          hasWorldWide: false
        })

        await deployEntity(context)

        expect(deployEntityFn).toHaveBeenCalledTimes(1)
        expect(undeployOtherWorldScenes).toHaveBeenCalledWith('test-world', entityId)
      })
    })

    describe('and the deployer has only per-parcel permission (not owner, not world-wide)', () => {
      it('should reject with NotAuthorizedError before deploying', async () => {
        const { context, deployEntityFn, undeployOtherWorldScenes } = createSingleSceneContext({
          isOwner: false,
          hasWorldWide: false
        })

        const error = await deployEntity(context).catch((e) => e)

        expect(error).toBeInstanceOf(NotAuthorizedError)
        expect(deployEntityFn).not.toHaveBeenCalled()
        expect(undeployOtherWorldScenes).not.toHaveBeenCalled()
      })
    })

    describe('and the flag is not set (normal deploy)', () => {
      it('should not undeploy any other scenes', async () => {
        const { context, deployEntityFn, undeployOtherWorldScenes } = createSingleSceneContext({
          isOwner: true,
          hasWorldWide: false,
          singleWorldScene: false
        })

        await deployEntity(context)

        expect(deployEntityFn).toHaveBeenCalledTimes(1)
        expect(undeployOtherWorldScenes).not.toHaveBeenCalled()
      })
    })

    describe('and it is not a world deploy (Genesis City, no worldConfiguration)', () => {
      const genesisEntityJson = JSON.stringify({
        type: 'scene',
        pointers: ['10,20'],
        timestamp: 1,
        content: [],
        metadata: { scene: { base: '10,20', parcels: ['10,20'] } }
      })

      it('should ignore the flag: deploy normally, with no authorization check or cleanup', async () => {
        const { context, deployEntityFn, undeployOtherWorldScenes, checkPermission } = createSingleSceneContext({
          isOwner: true,
          hasWorldWide: false,
          entityJson: genesisEntityJson
        })

        await deployEntity(context)

        expect(deployEntityFn).toHaveBeenCalledTimes(1)
        expect(checkPermission).not.toHaveBeenCalled()
        expect(undeployOtherWorldScenes).not.toHaveBeenCalled()
      })
    })
  })
})
