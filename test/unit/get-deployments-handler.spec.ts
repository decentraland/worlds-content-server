import { getDeploymentsHandler } from '../../src/controllers/handlers/get-deployments-handler'
import { DeploymentsResponse } from '../../src/types'

describe('getDeploymentsHandler', () => {
  let mockWorldsManager: any
  let mockResponse: DeploymentsResponse

  beforeEach(() => {
    mockWorldsManager = {
      getDeploymentsWithFilters: jest.fn()
    }

    mockResponse = {
      deployments: [],
      filters: {},
      pagination: { offset: 0, limit: 100, moreData: false }
    }

    mockWorldsManager.getDeploymentsWithFilters.mockResolvedValue(mockResponse)
  })

  const createMockContext = (queryParams: Record<string, string> = {}) => {
    const searchParams = new URLSearchParams(queryParams)

    return {
      url: {
        searchParams
      },
      components: {
        worldsManager: mockWorldsManager
      }
    } as any
  }

  it('should call worldsManager.getDeploymentsWithFilters with parsed filters', async () => {
    const context = createMockContext()

    const response = await getDeploymentsHandler(context)

    expect(response.status).toBe(200)
    expect(response.body).toEqual(mockResponse)
    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith({
      name: undefined,
      entityIds: undefined,
      deployer: undefined,
      owner: undefined,
      limit: 100,
      offset: 0
    })
  })

  it('should parse name filter correctly', async () => {
    const context = createMockContext({ name: 'world1.dcl.eth' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ['world1.dcl.eth']
      })
    )
  })

  it('should parse multiple names correctly', async () => {
    const context = createMockContext({ name: 'world1.dcl.eth,world2.dcl.eth' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ['world1.dcl.eth', 'world2.dcl.eth']
      })
    )
  })

  it('should lowercase filter values', async () => {
    const context = createMockContext({ name: 'WORLD1.DCL.ETH' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ['world1.dcl.eth']
      })
    )
  })

  it('should trim filter values', async () => {
    const context = createMockContext({ name: '  world1.dcl.eth  ' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        name: ['world1.dcl.eth']
      })
    )
  })

  it('should parse entityId filter correctly', async () => {
    const context = createMockContext({ entityId: 'bafkreixxx' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        entityIds: ['bafkreixxx']
      })
    )
  })

  it('should parse owner filter correctly', async () => {
    const context = createMockContext({ owner: '0xabc' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: ['0xabc']
      })
    )
  })

  it('should parse deployer filter correctly', async () => {
    const context = createMockContext({ deployer: '0xdef' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        deployer: ['0xdef']
      })
    )
  })

  it('should use default limit when not provided', async () => {
    const context = createMockContext()

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100
      })
    )
  })

  it('should parse custom limit correctly', async () => {
    const context = createMockContext({ limit: '50' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 50
      })
    )
  })

  it('should cap limit at 500', async () => {
    const context = createMockContext({ limit: '1000' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 500
      })
    )
  })

  it('should handle invalid limit by using default', async () => {
    const context = createMockContext({ limit: 'invalid' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 100
      })
    )
  })

  it('should handle negative limit by setting to 0', async () => {
    const context = createMockContext({ limit: '-10' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 0
      })
    )
  })

  it('should floor decimal limit values', async () => {
    const context = createMockContext({ limit: '10.7' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 10
      })
    )
  })

  it('should use default offset when not provided', async () => {
    const context = createMockContext()

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 0
      })
    )
  })

  it('should parse custom offset correctly', async () => {
    const context = createMockContext({ offset: '20' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 20
      })
    )
  })

  it('should handle invalid offset by using default', async () => {
    const context = createMockContext({ offset: 'invalid' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 0
      })
    )
  })

  it('should handle negative offset by setting to 0', async () => {
    const context = createMockContext({ offset: '-5' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 0
      })
    )
  })

  it('should floor decimal offset values', async () => {
    const context = createMockContext({ offset: '5.9' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        offset: 5
      })
    )
  })

  it('should handle empty filter values', async () => {
    const context = createMockContext({ name: '' })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith(
      expect.objectContaining({
        name: undefined
      })
    )
  })

  it('should handle multiple filters combined', async () => {
    const context = createMockContext({
      name: 'world1.dcl.eth',
      owner: '0xabc',
      deployer: '0xdef',
      limit: '50',
      offset: '10'
    })

    await getDeploymentsHandler(context)

    expect(mockWorldsManager.getDeploymentsWithFilters).toHaveBeenCalledWith({
      name: ['world1.dcl.eth'],
      entityIds: undefined,
      owner: ['0xabc'],
      deployer: ['0xdef'],
      limit: 50,
      offset: 10
    })
  })
})
