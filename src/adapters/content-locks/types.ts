import { IBaseComponent } from '@well-known-components/interfaces'

export interface IContentLocks extends IBaseComponent {
  /** Protects storage reads/writes through publication. Optional entity key serializes its batches. */
  withRead<T>(operation: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal, entityId?: string): Promise<T>
  /** Excludes uploads while references are checked and a GC batch is physically deleted. */
  withWrite<T>(operation: () => Promise<T>): Promise<T>
}
