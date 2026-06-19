import { IFetchComponent } from '@dcl/core-commons'
import { HTTPProvider, RPCSendableMessage } from 'eth-connect'
import { createEthereumProvider } from '../../src/adapters/rpc-provider'

// Promisifies a single HTTPProvider.sendAsync call so the test can assert
// whether the result/error was delivered to the callback. The whole point of
// the wrapper is that body-read failures arrive *here* (handled) rather than
// escaping as an unhandled promise rejection.
function sendAsyncOnce(provider: HTTPProvider, payload: RPCSendableMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    provider.sendAsync(payload as any, (err: any, result: any) => {
      if (err) {
        reject(err)
      } else {
        resolve(result)
      }
    })
  })
}

describe('when sending a request through the ethereum provider', () => {
  let fetchMock: jest.Mock
  let fetch: IFetchComponent
  let provider: HTTPProvider
  let payload: RPCSendableMessage

  beforeEach(() => {
    fetchMock = jest.fn()
    fetch = { fetch: fetchMock } as unknown as IFetchComponent
    provider = createEthereumProvider({ fetch }, 'https://rpc.example.org/mainnet')
    payload = { jsonrpc: '2.0', id: 1, method: 'eth_call', params: [] } as unknown as RPCSendableMessage
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('and the RPC responds with a valid JSON body', () => {
    let rpcResult: { jsonrpc: string; id: number; result: string }

    beforeEach(() => {
      rpcResult = { jsonrpc: '2.0', id: 1, result: '0xabc' }
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify(rpcResult)
      })
    })

    it('should deliver the parsed response body to the sendAsync callback', async () => {
      await expect(sendAsyncOnce(provider, payload)).resolves.toEqual(rpcResult)
    })
  })

  describe('and reading the response body fails with a premature close', () => {
    let prematureCloseError: Error & { code: string; type: string }

    beforeEach(() => {
      prematureCloseError = Object.assign(
        new Error('Invalid response body while trying to fetch https://rpc.example.org/mainnet: Premature close'),
        { type: 'system', code: 'ERR_STREAM_PREMATURE_CLOSE' }
      )
      fetchMock.mockResolvedValueOnce({
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => {
          throw prematureCloseError
        }
      })
    })

    it('should deliver the error to the sendAsync callback rather than letting it escape unhandled', async () => {
      await expect(sendAsyncOnce(provider, payload)).rejects.toBe(prematureCloseError)
    })
  })
})
