import SQL, { SQLStatement } from 'sql-template-strings'
import { AppComponents } from '../../types'
import { ISearchComponent, SearchableField } from './types'

export async function createSearchComponent({
  database,
  logs
}: Pick<AppComponents, 'database' | 'logs'>): Promise<ISearchComponent> {
  const logger = logs.getLogger('search-component')

  // Cache for pg_trgm extension availability check
  let trigramExtensionAvailable: boolean | null = null

  async function isTrigramExtensionAvailable(): Promise<boolean> {
    if (trigramExtensionAvailable !== null) {
      return trigramExtensionAvailable
    }

    try {
      const result = await database.query<{ installed: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'
        ) as installed
      `)
      trigramExtensionAvailable = result.rows[0]?.installed ?? false

      if (!trigramExtensionAvailable) {
        logger.warn(
          'pg_trgm extension is not available. Fuzzy similarity search will be disabled. ' +
            'Search will still work using full-text search and ILIKE patterns.'
        )
      }
    } catch {
      trigramExtensionAvailable = false
    }

    return trigramExtensionAvailable
  }

  async function buildLikeSearchFilter(
    searchTerm: string,
    fields: SearchableField[],
    options?: {
      similarityThreshold?: number
    }
  ): Promise<SQLStatement> {
    const useTrigramSearch = await isTrigramExtensionAvailable()
    const threshold = options?.similarityThreshold ?? 0.3

    const filter = SQL``
    const conditions: SQLStatement[] = []

    // Add ILIKE conditions for each field
    for (const field of fields) {
      const ilikeCondition = SQL``
      ilikeCondition.append(`${field.column} ILIKE '%' || `)
      ilikeCondition.append(SQL`${searchTerm}`)
      ilikeCondition.append(` || '%'`)
      conditions.push(ilikeCondition)
    }

    // Add similarity conditions if trigram is available
    if (useTrigramSearch) {
      for (const field of fields) {
        const simCondition = SQL``
        if (field.nullable) {
          simCondition.append(`similarity(COALESCE(${field.column}, ''), `)
        } else {
          simCondition.append(`similarity(${field.column}, `)
        }
        simCondition.append(SQL`${searchTerm}`)
        simCondition.append(`) > ${threshold}`)
        conditions.push(simCondition)
      }
    }

    // Join all conditions with OR
    conditions.forEach((condition, index) => {
      if (index > 0) {
        filter.append(SQL`
            OR `)
      }
      filter.append(condition)
    })

    return filter
  }

  return {
    isTrigramExtensionAvailable,
    buildLikeSearchFilter
  }
}
