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
    it('should extract world runtime metadata from Entity', function () {
      const entity = {
        id: 'bafi',
        version: 'v3',
        type: EntityType.SCENE,
        pointers: ['20,24'],
        timestamp: 1689683357974,
        content: [
          {
            file: '0ee02d9e-7d23-42d9-a0c9-e1394ac0a98a/FloorBaseSand_01/FloorBaseSand_01.glb',
            hash: 'bafkreieklxug2qtq25c3iwhrgtmp7fr6mmluuhzsru3f4xpl7h7rtadahy'
          },
          {
            file: '0ee02d9e-7d23-42d9-a0c9-e1394ac0a98a/FloorBaseSand_01/Floor_Sand01.png.001.png',
            hash: 'bafkreiflckzgpjcirb2hprlbrhtaalci3saxrph5jtg27bwh5mko5y2u5u'
          },
          {
            file: '0ee02d9e-7d23-42d9-a0c9-e1394ac0a98a/FloorBaseSand_01/thumbnail.png',
            hash: 'bafkreible6vy32awvf4baxzmvkg23fhztayxfdg5jg4cielcytu6pdnq4u'
          },
          {
            file: '390b876e-4b3a-4e78-bd03-5be21b1ecc67/WaterPatchFull_01/PiratesPack_TX.png.png',
            hash: 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq'
          },
          {
            file: '390b876e-4b3a-4e78-bd03-5be21b1ecc67/WaterPatchFull_01/WaterPatchFull_01.glb',
            hash: 'bafkreiek2guc7hc3jqiiemotaikiynfuoff3bsc625xtqh7dq5ohy6eei4'
          },
          {
            file: '390b876e-4b3a-4e78-bd03-5be21b1ecc67/WaterPatchFull_01/thumbnail.png',
            hash: 'bafkreigm3ap3bnkuqfuince27foke6u4bw3hyrqusl7evutcdibh7tzfke'
          },
          {
            file: '60e6cab6-ad1b-460e-875a-8c55bc8f3892/RockBig_03/PiratesPack_TX.png.png',
            hash: 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq'
          },
          {
            file: '60e6cab6-ad1b-460e-875a-8c55bc8f3892/RockBig_03/RockBig_03.glb',
            hash: 'bafkreiblvcmkynigyhhxfe3mbaaimxubktwad4wlxjalhqtg5hqbx4g6ya'
          },
          {
            file: '60e6cab6-ad1b-460e-875a-8c55bc8f3892/RockBig_03/thumbnail.png',
            hash: 'bafkreigrit52si3j5hvdxpffqwuch3tgkizgm3ahhrh4u55iwnje744nxy'
          },
          {
            file: '6922eea0-67a6-4559-917c-df33aa1d9954/Bamboo_01/Bamboo_01.glb',
            hash: 'bafkreihmrdfpkn7inikjujuidhdzuflwlureqm5pmzfquky5vsa6dyrbay'
          },
          {
            file: '6922eea0-67a6-4559-917c-df33aa1d9954/Bamboo_01/PiratesPack_TX.png.png',
            hash: 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq'
          },
          {
            file: '6922eea0-67a6-4559-917c-df33aa1d9954/Bamboo_01/thumbnail.png',
            hash: 'bafkreiegcthjclfo3lzcgqrbnhokfvyqa662hpum3nh6tvhe6jcwzcdcie'
          },
          {
            file: '75f2ea4e-e061-4627-ae43-9460aa106066/WaterPatchCurve_02/PiratesPack_TX.png',
            hash: 'bafkreidzr6ankbumaiw5clcony5vsygkvycv4whxeorjgcc4ixcmg4w6py'
          },
          {
            file: '75f2ea4e-e061-4627-ae43-9460aa106066/WaterPatchCurve_02/WaterPatchCurve_02.glb',
            hash: 'bafkreiezwmpkinrtbzgglxuowddzh5eflrdw2jo6vngtt3s7tzijynbkbq'
          },
          {
            file: '75f2ea4e-e061-4627-ae43-9460aa106066/WaterPatchCurve_02/thumbnail.png',
            hash: 'bafkreidpt2ss6szjbug4zdrqesim3cweet6kcwjndmwz44bcg4jbwmhhoe'
          },
          { file: 'bin/game.js', hash: 'bafkreicamuc5d73gwl7nefr5jofj4hxm3u7cuy5k3abo26j5cw7tkdorn4' },
          { file: 'bin/game.js.lib', hash: 'bafkreihrd4gdem2o2hgkw4u2xnf5pxagubpluu5p6dqbf7hyyyhwwsvvhe' },
          { file: 'black_image.png', hash: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq' },
          { file: 'builder.json', hash: 'bafkreid2e3o3utgi54u3xtsj7ome6oxwhcqm7nyjzvt7fcmeumesai7mhu' },
          {
            file: 'materials/sky-photo-beautiful-sunset.jpg',
            hash: 'bafybeiahb23pt7sj3ksureogcoagrjs74k6a22wfhwkw562wmva34jkvoy'
          },
          { file: 'scene-thumbnail.png', hash: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq' },
          { file: 'scene.json', hash: 'bafkreiffrbhafnfsqfe7bdfdelm2tmbtoxm5hek65kvsvjyrwomtmmpcri' },
          { file: 'scene.json.catalyst', hash: 'bafkreie3crrqqgiho7mxt5zqypevjrlqxpzka77vqxtbvctcgruwzr4ouq' },
          { file: 'scene.json.worlds', hash: 'bafkreig2raaodw5wdhnumauffj4bjkgozug7cic5qcvjbosueivnmxquta' }
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
            miniMapConfig: { visible: false, dataImage: 'black_image.png', estateImage: 'white_image.png' },
            skyboxConfig: { fixedHour: 36000, textures: ['black_image.png'] }
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

      const worldRuntimeMetadata = extractWorldRuntimeMetadata('saracatunga.dcl.eth', entity)
      expect(worldRuntimeMetadata).toEqual({
        entityIds: ['bafi'],
        minimapDataImage: 'bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq',
        minimapEstateImage: undefined,
        minimapVisible: false,
        name: 'saracatunga.dcl.eth',
        skyboxTextures: ['bafkreidduubi76bntd27dewz4cvextrfl3qyd4td6mtztuisxi26q64dnq'],
        thumbnailFile: 'bafkreic4chubh3cavwuzgsvszpmhi4zqpf5kfgt6goufuarwbzv4yrkdqq'
      })
    })
  })
})
