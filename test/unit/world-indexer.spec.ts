import { createWorldsIndexerComponent } from '../../src/adapters/worlds-indexer'
import { createInMemoryStorage, IContentStorageComponent } from '@dcl/catalyst-storage'
import { Entity } from '@dcl/schemas'
import { IWorldsIndexer, IWorldsManager } from '../../src/types'
import { createWorldsManagerMockComponent } from '../mocks/worlds-manager-mock'

describe('when indexing worlds', function () {
  let storage: IContentStorageComponent
  let worldsManager: IWorldsManager
  let worldsIndexer: IWorldsIndexer

  beforeEach(async () => {
    storage = createInMemoryStorage()
    worldsManager = await createWorldsManagerMockComponent({ storage })
    worldsIndexer = await createWorldsIndexerComponent({ worldsManager })
  })

  describe('and there are deployed worlds with scenes', () => {
    const entity1: Entity = {
      version: 'v3',
      type: 'scene' as any,
      id: 'bafkreielwj3ki46munydwn4ayazdvmjln76khmz2xyaf5v6dkmo6yoebbi',
      pointers: ['20,24'],
      timestamp: 1683909215429,
      content: [{ file: 'scene-thumbnail.png', hash: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }],
      metadata: {
        display: {
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          navmapThumbnail: 'scene-thumbnail.png'
        },
        main: 'bin/game.js',
        worldConfiguration: {
          name: 'world-name.dcl.eth'
        },
        scene: { base: '20,24', parcels: ['20,24'] }
      }
    }

    const entity2: Entity = {
      version: 'v3',
      type: 'scene' as any,
      id: 'bafkreic6ix3pdwf7g24reg4ktlyjpmtbqbc2nq4zocupkmul37am4vlt6y',
      pointers: ['20,24'],
      timestamp: 1684263239610,
      content: [{ file: 'scene-thumbnail.png', hash: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq' }],
      metadata: {
        display: {
          title: 'Mi propia escena',
          description: 'Mi lugar en el mundo',
          navmapThumbnail: 'scene-thumbnail.png'
        },
        main: 'bin/game.js',
        worldConfiguration: {
          name: 'another-world-name.dcl.eth'
        },
        scene: { base: '20,24', parcels: ['20,24'] }
      }
    }

    beforeEach(async () => {
      await worldsManager.deployScene('world-name.dcl.eth', entity1, '0x1234567890123456789012345678901234567890')
      await worldsManager.deployScene(
        'another-world-name.dcl.eth',
        entity2,
        '0x1234567890123456789012345678901234567891'
      )
    })

    it('should create an index with all deployed worlds and their scenes', async () => {
      const worldsIndex = await worldsIndexer.getIndex()

      expect(worldsIndex).toEqual({
        index: [
          {
            name: 'world-name.dcl.eth',
            scenes: [
              {
                description: 'Mi lugar en el mundo',
                id: 'bafkreielwj3ki46munydwn4ayazdvmjln76khmz2xyaf5v6dkmo6yoebbi',
                pointers: ['20,24'],
                thumbnail: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku',
                timestamp: 1683909215429,
                title: 'Mi propia escena'
              }
            ]
          },
          {
            name: 'another-world-name.dcl.eth',
            scenes: [
              {
                description: 'Mi lugar en el mundo',
                id: 'bafkreic6ix3pdwf7g24reg4ktlyjpmtbqbc2nq4zocupkmul37am4vlt6y',
                pointers: ['20,24'],
                thumbnail: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
                timestamp: 1684263239610,
                title: 'Mi propia escena'
              }
            ]
          }
        ],
        timestamp: expect.any(Number)
      })
    })
  })

  describe('and there are worlds without scenes', () => {
    beforeEach(async () => {
      // Deploy a world with a scene first
      const entity: Entity = {
        version: 'v3',
        type: 'scene' as any,
        id: 'bafkreielwj3ki46munydwn4ayazdvmjln76khmz2xyaf5v6dkmo6yoebbi',
        pointers: ['20,24'],
        timestamp: 1683909215429,
        content: [{ file: 'scene-thumbnail.png', hash: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' }],
        metadata: {
          display: {
            title: 'Test Scene',
            description: 'A test scene',
            navmapThumbnail: 'scene-thumbnail.png'
          },
          main: 'bin/game.js',
          worldConfiguration: {
            name: 'world-with-scene.dcl.eth'
          },
          scene: { base: '20,24', parcels: ['20,24'] }
        }
      }
      await worldsManager.deployScene('world-with-scene.dcl.eth', entity, '0x1234567890123456789012345678901234567890')
    })

    it('should only include worlds that have scenes in the index', async () => {
      const worldsIndex = await worldsIndexer.getIndex()

      expect(worldsIndex.index).toHaveLength(1)
      expect(worldsIndex.index[0].name).toBe('world-with-scene.dcl.eth')
    })
  })
})
