import { migrateMetadata } from '../../src/logic/world-metadata-migrator'
import { WorldMetadata } from '../../src/types'

describe('world-metadata-migrator', function () {
  it('should migrate dclName to name', function () {
    const metadata = {
      entityId: 'whatever',
      config: { dclName: 'whatever.dcl.eth' }
    } as WorldMetadata

    const migrated = migrateMetadata(metadata)

    expect(migrated).toMatchObject({
      entityId: 'whatever',
      config: { name: 'whatever.dcl.eth' }
    })
  })

  it('should migrate minimapVisible to miniMapConfig', function () {
    const metadata = {
      entityId: 'whatever',
      config: { name: 'whatever.dcl.eth', minimapVisible: true }
    } as WorldMetadata

    const migrated = migrateMetadata(metadata)

    expect(migrated).toMatchObject({
      entityId: 'whatever',
      config: { name: 'whatever.dcl.eth', miniMapConfig: { visible: true } }
    })
  })

  it('should migrate skybox to skyboxConfig', function () {
    const metadata = {
      entityId: 'whatever',
      config: { name: 'whatever.dcl.eth', skybox: 3600 }
    } as WorldMetadata

    const migrated = migrateMetadata(metadata)

    expect(migrated).toMatchObject({
      entityId: 'whatever',
      config: { name: 'whatever.dcl.eth', skyboxConfig: { fixedTime: 3600 } }
    })
  })
})
