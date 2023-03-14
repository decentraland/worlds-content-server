import { createFetchComponent } from '../../src/adapters/fetch'
import { IFetchComponent } from '@well-known-components/http-server'
import PQueue from 'p-queue'

async function fetchForWorld(baseUrl: string, name: string, fetcher: IFetchComponent) {
  const aboutRes = await fetcher.fetch(`${baseUrl}/world/${name}/about`)
  const about = await aboutRes.json()

  const entities = {}
  for (const urn of about.configurations.scenesUrn) {
    const ipfsRegex = /^urn:decentraland:entity:([a-zA-Z0-9]+)\?.*$/
    const match = urn.match(ipfsRegex)
    if (!match) {
      continue
    }

    const entityId = match[1]
    try {
      const sceneJsonRes = await fetcher.fetch(`${baseUrl}/contents/${entityId}`)
      const sceneJson = await sceneJsonRes.json()
      if (!sceneJson) {
        continue
      }
      entities[entityId] = {
        parcels: sceneJson.pointers.length,
        sdk: sceneJson.metadata?.runtimeVersion
      }
    } catch (e) {
      console.log('ERROR', e.message)
    }
    return entities
  }
}

describe('All data from worlds', function () {
  const baseUrl = 'http://localhost:3000'
  const authorization = 'Bearer mariano'

  it(
    'returns list of worlds together with number of parcels for each',
    async () => {
      const fetcher = await createFetchComponent()
      const statusRes = await fetcher.fetch(`${baseUrl}/status`, {
        headers: {
          Authorization: authorization
        }
      })
      const status = await statusRes.json()

      const queue = new PQueue({ concurrency: 10 })
      const worldsWithParcels = {}
      for (const [index, name] of status.content.details.entries()) {
        void queue.add(async () => {
          try {
            console.log(`Fetching data about world #${index} ${name}`)
            worldsWithParcels[name] = await fetchForWorld(baseUrl, name, fetcher)
          } catch (e) {
            console.log('ERROR', e)
          }
        })
      }

      await queue.onEmpty()
      console.log(JSON.stringify(worldsWithParcels, undefined, 2))
    },
    10 * 60 * 1000 // 10 minutes
  )
})
