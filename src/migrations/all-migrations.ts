import { Migration } from '../types'
import { migration as migration_0001 } from './0001_fix_file_ids'
import { migration as migration_0002 } from './0002_create_worlds_table'
import { migration as migration_0003 } from './0003_compute_and_store_runtime_metadata'
import { migration as migration_0004 } from './0004_migrate_from_files_to_database'
import { migration as migration_0005 } from './0005_add_permissions_column'
import { migration as migration_0006 } from './0006_migrate_acls_to_permissions'
import { migration as migration_0007 } from './0007_fix_empty_permissions'
import { migration as migration_0008 } from './0008_make_permissions_column_not_null'
import { migration as migration_0009 } from './0009_drop_acl_column'
import { migration as migration_0010 } from './0010_remove_world_metadata_files'
import { migration as migration_0011 } from './0011_add_size_and_owner_columns'
import { migration as migration_0012 } from './0012_store_world_owner_and_size'
import { migration as migration_0013 } from './0013_create_blocked_table'

export const allMigrations: Migration[] = [
  migration_0001,
  migration_0002,
  migration_0003,
  migration_0004,
  migration_0005,
  migration_0006,
  migration_0007,
  migration_0008,
  migration_0009,
  migration_0010,
  migration_0011,
  migration_0012,
  migration_0013
]
