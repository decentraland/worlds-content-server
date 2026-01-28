import { createLogComponent } from '@well-known-components/logger'
import { ILoggerComponent } from '@well-known-components/interfaces'
import { IPgComponent } from '@well-known-components/pg-component'
import { createSearchComponent, ISearchComponent } from '../../src/adapters/search'

describe('SearchComponent', () => {
  let logs: ILoggerComponent
  let database: jest.Mocked<IPgComponent>
  let searchComponent: ISearchComponent

  beforeEach(async () => {
    logs = await createLogComponent({})
    database = {
      query: jest.fn(),
      getPool: jest.fn(),
      start: jest.fn(),
      stop: jest.fn(),
      streamQuery: jest.fn()
    } as unknown as jest.Mocked<IPgComponent>
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe('when checking if trigram extension is available', () => {
    describe('and the extension is installed', () => {
      beforeEach(async () => {
        database.query.mockResolvedValueOnce({
          rows: [{ installed: true }],
          rowCount: 1
        } as any)

        searchComponent = await createSearchComponent({ database, logs })
      })

      it('should return true', async () => {
        const result = await searchComponent.isTrigramExtensionAvailable()
        expect(result).toBe(true)
      })

      it('should query the database for pg_trgm extension', async () => {
        await searchComponent.isTrigramExtensionAvailable()
        expect(database.query).toHaveBeenCalledWith(expect.stringContaining('SELECT EXISTS'))
      })

      describe('and calling isTrigramExtensionAvailable again', () => {
        it('should return the cached result without querying the database again', async () => {
          await searchComponent.isTrigramExtensionAvailable()
          await searchComponent.isTrigramExtensionAvailable()

          expect(database.query).toHaveBeenCalledTimes(1)
        })
      })
    })

    describe('and the extension is not installed', () => {
      beforeEach(async () => {
        database.query.mockResolvedValueOnce({
          rows: [{ installed: false }],
          rowCount: 1
        } as any)

        searchComponent = await createSearchComponent({ database, logs })
      })

      it('should return false', async () => {
        const result = await searchComponent.isTrigramExtensionAvailable()
        expect(result).toBe(false)
      })
    })

    describe('and the query fails', () => {
      beforeEach(async () => {
        database.query.mockRejectedValueOnce(new Error('Database error'))

        searchComponent = await createSearchComponent({ database, logs })
      })

      it('should return false', async () => {
        const result = await searchComponent.isTrigramExtensionAvailable()
        expect(result).toBe(false)
      })
    })

    describe('and the query returns no rows', () => {
      beforeEach(async () => {
        database.query.mockResolvedValueOnce({
          rows: [],
          rowCount: 0
        } as any)

        searchComponent = await createSearchComponent({ database, logs })
      })

      it('should return false', async () => {
        const result = await searchComponent.isTrigramExtensionAvailable()
        expect(result).toBe(false)
      })
    })
  })

  describe('when building a like search filter', () => {
    describe('and trigram extension is available', () => {
      beforeEach(async () => {
        database.query.mockResolvedValueOnce({
          rows: [{ installed: true }],
          rowCount: 1
        } as any)

        searchComponent = await createSearchComponent({ database, logs })
      })

      describe('and searching with a single non-nullable field', () => {
        it('should include ILIKE and similarity conditions', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [{ column: 'name', nullable: false }])

          const sql = filter.text
          expect(sql).toContain("name ILIKE '%' ||")
          expect(sql).toContain('similarity(name,')
          expect(sql).toContain('> 0.3')
        })
      })

      describe('and searching with a single nullable field', () => {
        it('should wrap similarity with COALESCE', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [{ column: 'title', nullable: true }])

          const sql = filter.text
          expect(sql).toContain("title ILIKE '%' ||")
          expect(sql).toContain("similarity(COALESCE(title, ''),")
        })
      })

      describe('and searching with multiple fields', () => {
        it('should include conditions for all fields joined by OR', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [
            { column: 'name', nullable: false },
            { column: 'title', nullable: true },
            { column: 'description', nullable: true }
          ])

          const sql = filter.text
          // Check ILIKE conditions
          expect(sql).toContain("name ILIKE '%' ||")
          expect(sql).toContain("title ILIKE '%' ||")
          expect(sql).toContain("description ILIKE '%' ||")
          // Check similarity conditions
          expect(sql).toContain('similarity(name,')
          expect(sql).toContain("similarity(COALESCE(title, ''),")
          expect(sql).toContain("similarity(COALESCE(description, ''),")
          // Check OR joins
          expect(sql.match(/OR/g)?.length).toBe(5) // 3 ILIKEs + 3 similarities - 1 = 5 ORs
        })
      })

      describe('and providing a custom similarity threshold', () => {
        it('should use the custom threshold', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [{ column: 'name', nullable: false }], {
            similarityThreshold: 0.5
          })

          const sql = filter.text
          expect(sql).toContain('> 0.5')
        })
      })

      describe('and the search term contains special characters', () => {
        it('should properly parameterize the search term', async () => {
          const filter = await searchComponent.buildLikeSearchFilter("test's value", [
            { column: 'name', nullable: false }
          ])

          // The search term should be in the values array (parameterized)
          expect(filter.values).toContain("test's value")
        })
      })
    })

    describe('and trigram extension is not available', () => {
      beforeEach(async () => {
        database.query.mockResolvedValueOnce({
          rows: [{ installed: false }],
          rowCount: 1
        } as any)

        searchComponent = await createSearchComponent({ database, logs })
      })

      describe('and searching with fields', () => {
        it('should only include ILIKE conditions without similarity', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [
            { column: 'name', nullable: false },
            { column: 'title', nullable: true }
          ])

          const sql = filter.text
          // Check ILIKE conditions are present
          expect(sql).toContain("name ILIKE '%' ||")
          expect(sql).toContain("title ILIKE '%' ||")
          // Check similarity conditions are NOT present
          expect(sql).not.toContain('similarity(')
        })

        it('should join conditions with OR', async () => {
          const filter = await searchComponent.buildLikeSearchFilter('test', [
            { column: 'name', nullable: false },
            { column: 'title', nullable: true }
          ])

          const sql = filter.text
          expect(sql.match(/OR/g)?.length).toBe(1) // 2 ILIKEs - 1 = 1 OR
        })
      })
    })
  })
})
