import { SQLStatement } from 'sql-template-strings'

export type SearchableField = {
  column: string
  /** If true, wrap with COALESCE(..., '') for nullable columns */
  nullable?: boolean
}

export type ISearchComponent = {
  /**
   * Checks if the pg_trgm extension is available in the database.
   * The result is cached after the first check.
   */
  isTrigramExtensionAvailable(): Promise<boolean>

  /**
   * Builds a search filter SQL fragment that combines:
   * 1. ILIKE patterns for substring matching
   * 2. Trigram similarity for fuzzy matching (if pg_trgm is available)
   *
   * Note: This function does NOT include full-text search (tsvector).
   * Add full-text search conditions separately if needed.
   *
   * @param search - The search term
   * @param fields - Array of fields to search with ILIKE and similarity
   * @param options - Optional configuration
   * @returns SQL fragment with OR-joined conditions (without leading AND or parentheses)
   */
  buildLikeSearchFilter(
    search: string,
    fields: SearchableField[],
    options?: {
      /** Similarity threshold for trigram matching (default: 0.3) */
      similarityThreshold?: number
    }
  ): Promise<SQLStatement>
}
