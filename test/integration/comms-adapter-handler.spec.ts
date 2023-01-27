import { test } from '../components'
import {
  AUTH_CHAIN_HEADER_PREFIX,
  AUTH_METADATA_HEADER,
  AUTH_TIMESTAMP_HEADER
} from 'decentraland-crypto-middleware/lib/types'
import { AuthChain } from '@dcl/schemas'
import { Authenticator } from '@dcl/crypto'
import { getIdentity } from '../utils'

test('comms adapter handler /get-comms-adapter/:roomId', function ({ components }) {
  it('works when signed-fetch request is correct', async () => {
    const { localFetch } = components

    const identity = await getIdentity()

    const path = '/get-comms-adapter/myRoom'
    const actualInit = {
      method: 'POST',
      headers: {
        ...getAuthHeaders(
          'post',
          path,
          {
            origin: 'https://play.decentraland.org',
            intent: 'dcl:explorer:comms-handshake',
            signer: 'dcl:explorer',
            isGuest: 'false'
          },
          (payload) =>
            Authenticator.signPayload(
              {
                ephemeralIdentity: identity.ephemeralIdentity,
                expiration: new Date(),
                authChain: identity.authChain.authChain
              },
              payload
            )
        )
      }
    }

    const r = await localFetch.fetch(path, actualInit)

    expect(r.status).toEqual(200)
    expect(await r.json()).toEqual({
      fixedAdapter: 'ws-room:ws-room-service.decentraland.org/rooms/myRoom'
    })
  })
})

test('comms adapter handler /get-comms-adapter/:roomId', function ({ components }) {
  it('fails when request is not a signed-fetch one', async () => {
    const { localFetch } = components

    const r = await localFetch.fetch('/get-comms-adapter/roomId', {
      method: 'POST'
    })

    expect(r.status).toEqual(400)
    expect(await r.json()).toEqual({
      message: 'Invalid Auth Chain',
      ok: false
    })
  })
})

export function getAuthHeaders(
  method: string,
  path: string,
  metadata: Record<string, any>,
  chainProvider: (payload: string) => AuthChain
) {
  const headers: Record<string, string> = {}
  const timestamp = Date.now()
  const metadataJSON = JSON.stringify(metadata)
  const payloadParts = [method.toLowerCase(), path.toLowerCase(), timestamp.toString(), metadataJSON]
  const payloadToSign = payloadParts.join(':').toLowerCase()

  const chain = chainProvider(payloadToSign)

  chain.forEach((link, index) => {
    headers[`${AUTH_CHAIN_HEADER_PREFIX}${index}`] = JSON.stringify(link)
  })

  headers[AUTH_TIMESTAMP_HEADER] = timestamp.toString()
  headers[AUTH_METADATA_HEADER] = metadataJSON

  return headers
}