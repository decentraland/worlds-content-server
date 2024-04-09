import { extractWorldRuntimeMetadata, migrateConfiguration } from '../../src/logic/world-runtime-metadata-utils'
import { EntityType, WorldConfiguration } from '@dcl/schemas'

describe('world-runtime-metadata-utils', function () {
  describe('migrateConfiguration', function () {
    it('should migrate do nothing when no config', function () {
      const migrated = migrateConfiguration('worldName', undefined)

      expect(migrated).toEqual({ name: 'worldName' })
    })

    it('should migrate dclName to name', function () {
      const worldConfiguration = {
        dclName: 'whatever.dcl.eth'
      } as WorldConfiguration

      const migrated = migrateConfiguration('worldName', worldConfiguration)

      expect(migrated).toEqual({
        name: 'whatever.dcl.eth'
      })
    })

    it('should migrate minimapVisible to miniMapConfig', function () {
      const worldConfiguration = {
        name: 'whatever.dcl.eth',
        minimapVisible: true
      }

      const migrated = migrateConfiguration('worldName', worldConfiguration)

      expect(migrated).toEqual({
        name: 'whatever.dcl.eth',
        miniMapConfig: { visible: true }
      })
    })

    it('should migrate skybox to skyboxConfig even for fixed time 0', function () {
      const worldConfiguration = {
        name: 'whatever.dcl.eth',
        skybox: 0
      }

      const migrated = migrateConfiguration('worldName', worldConfiguration)

      expect(migrated).toEqual({
        name: 'whatever.dcl.eth',
        skyboxConfig: { fixedTime: 0 }
      })
    })

    it('should migrate skybox to skyboxConfig', function () {
      const worldConfiguration = {
        name: 'whatever.dcl.eth',
        skybox: 3600
      }

      const migrated = migrateConfiguration('worldName', worldConfiguration)

      expect(migrated).toEqual({
        name: 'whatever.dcl.eth',
        skyboxConfig: { fixedTime: 3600 }
      })
    })
  })

  describe('extractWorldRuntimeMetadata', function () {
    const entity1 = {
      id: 'bafi1',
      version: 'v3',
      type: EntityType.SCENE,
      pointers: ['20,24'],
      timestamp: 1689683357974,
      content: [
        { file: 'black_image.png', hash: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq' },
        { file: 'scene-thumbnail.png', hash: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq' }
      ],
      metadata: {
        display: {
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          favicon: 'favicon_asset',
          navmapThumbnail: 'scene-thumbnail.png'
        },
        owner: '',
        contact: { name: 'Po', email: '' },
        main: 'bin/game.js',
        tags: [],
        worldConfiguration: {
          name: 'saracatunga.dcl.eth',
          placesConfig: { optOut: true },
          miniMapConfig: { visible: true, dataImage: 'black_image.png', estateImage: 'white_image.png' },
          skyboxConfig: { fixedTime: 36000, textures: ['black_image.png'] }
        },
        source: {
          version: 1,
          origin: 'builder',
          projectId: '70bbe5e9-460c-4d1b-bb9f-7597e71747df',
          point: { x: 0, y: 0 },
          rotation: 'east',
          layout: { rows: 1, cols: 1 }
        },
        scene: { base: '20,24', parcels: ['20,24'] }
      }
    }
    const entity2 = {
      id: 'bafi2',
      version: 'v3',
      type: EntityType.SCENE,
      pointers: ['20,24'],
      timestamp: entity1.timestamp + 1,
      content: [
        { file: 'black_image.png', hash: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq' },
        { file: 'scene-thumbnail.png', hash: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq' }
      ],
      metadata: {
        display: {
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          favicon: 'favicon_asset',
          navmapThumbnail: 'scene-thumbnail.png'
        },
        owner: '',
        contact: { name: 'Po', email: '' },
        main: 'bin/game.js',
        tags: [],
        worldConfiguration: {
          name: 'saracatunga.dcl.eth',
          placesConfig: { optOut: false },
          miniMapConfig: { visible: false, dataImage: 'black_image.png', estateImage: 'white_image.png' },
          skyboxConfig: { fixedTime: 0, textures: ['black_image.png'] }
        },
        source: {
          version: 1,
          origin: 'builder',
          projectId: '70bbe5e9-460c-4d1b-bb9f-7597e71747df',
          point: { x: 0, y: 0 },
          rotation: 'east',
          layout: { rows: 1, cols: 1 }
        },
        scene: { base: '20,24', parcels: ['20,24'] }
      }
    }

    it('should extract world runtime metadata from Entity', function () {
      const worldRuntimeMetadata = extractWorldRuntimeMetadata('saracatunga.dcl.eth', [entity1])
      expect(worldRuntimeMetadata).toEqual({
        entityIds: ['bafi1'],
        minimapDataImage: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
        minimapEstateImage: undefined,
        minimapVisible: true,
        skyboxFixedTime: 36000,
        name: 'saracatunga.dcl.eth',
        skyboxTextures: ['bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq'],
        thumbnailFile: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
      })
    })

    it('should extract world runtime metadata from 2 scenes', function () {
      const worldRuntimeMetadata = extractWorldRuntimeMetadata('saracatunga.dcl.eth', [entity1, entity2])
      expect(worldRuntimeMetadata).toEqual({
        entityIds: ['bafi1', 'bafi2'],
        minimapDataImage: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
        minimapEstateImage: undefined,
        minimapVisible: false,
        skyboxFixedTime: 0,
        name: 'saracatunga.dcl.eth',
        skyboxTextures: ['bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq'],
        thumbnailFile: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
      })
    })
  })
})
