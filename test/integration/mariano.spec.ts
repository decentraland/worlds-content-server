import { createFetchComponent } from '../../src/adapters/fetch'
import * as fs from 'fs'

describe('All data from worlds', function () {
  // const baseUrl = 'http://localhost:3000'
  // const baseUrl = 'https://worlds-content-server.decentraland.zone'
  const baseUrl = 'https://worlds-content-server.decentraland.org'

  it(
    'returns list of worlds together with number of parcels for each',
    async () => {
      const fetcher = await createFetchComponent()
      const indexResponse = await fetcher.fetch(`${baseUrl}/index`)
      const index = await indexResponse.json()

      const worldNames = index.data.map((world: any) => world.name)
      console.log(JSON.stringify(worldNames, undefined, 2))

      const statsResponse = await fetcher.fetch(
        `${baseUrl.replace('worlds-content-server', 'dcl-name-stats')}/should-index`,
        {
          method: 'POST',
          body: JSON.stringify({
            dclNames: worldNames
          })
        }
      )
      const stats = await statsResponse.json()
      console.log(JSON.stringify(stats, undefined, 2))

      fs.writeFileSync('contents/data-for-indexing.json', JSON.stringify(stats, undefined, 2))
    },
    10 * 60 * 1000 // 10 minutes
  )
})
