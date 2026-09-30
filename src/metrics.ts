import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/http-server'
import { validateMetricsDeclaration } from '@dcl/metrics'
import { metricDeclarations as theGraphMetricDeclarations } from '@dcl/thegraph-component'
import { metricDeclarations as pgMetricDeclarations } from '@dcl/pg-component'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  ...theGraphMetricDeclarations,
  ...pgMetricDeclarations,
  partial_upload_metadata_checks: {
    help: 'Content metadata checks performed by partial uploads',
    type: IMetricsComponent.CounterType
  },
  partial_upload_batches: {
    help: 'Accepted partial upload batches',
    type: IMetricsComponent.CounterType,
    labelNames: ['outcome']
  },
  partial_upload_reserved_bytes: {
    help: 'Staging bytes reserved, including expired uploads awaiting cleanup',
    type: IMetricsComponent.GaugeType
  },
  partial_upload_cleanup_backlog_bytes: {
    help: 'Expired staging bytes awaiting successful cleanup',
    type: IMetricsComponent.GaugeType
  },
  partial_upload_capacity_bytes: {
    help: 'Server-wide staging byte cap for partial uploads (MAX_PENDING_BYTES)',
    type: IMetricsComponent.GaugeType
  },
  partial_upload_requests: {
    help: 'Partial upload batches by response outcome',
    type: IMetricsComponent.CounterType,
    // outcome=(accepted|finalized|validation_error|throttled|timeout|aborted|error)
    labelNames: ['outcome']
  },
  partial_upload_throttled: {
    help: 'Partial upload batches answered 429, by the quota that rejected them',
    type: IMetricsComponent.CounterType,
    // reason=(uploads_per_account|bytes_per_account|bytes_per_server|bytes_per_minute)
    labelNames: ['reason']
  },
  partial_uploads_started: {
    help: 'Partial uploads whose first batch was admitted',
    type: IMetricsComponent.CounterType
  },
  partial_uploads_completed: {
    help: 'Partial uploads published by their final batch',
    type: IMetricsComponent.CounterType
  },
  partial_uploads_pending: {
    help: 'Partial uploads in the database at the last cleanup run (server-wide)',
    type: IMetricsComponent.GaugeType,
    // state=(live|expired)
    labelNames: ['state']
  },
  partial_upload_duration_seconds: {
    help: 'Time from a partial upload first batch arrival to its publication',
    type: IMetricsComponent.HistogramType,
    buckets: [5, 15, 30, 60, 120, 300, 600, 900, 1800, 2700, 3600]
  },
  partial_upload_batches_per_upload: {
    help: 'Stored batches a partial upload took until publication',
    type: IMetricsComponent.HistogramType,
    buckets: [1, 2, 3, 5, 10, 20, 50, 100, 250]
  },
  partial_upload_expired_uploads: {
    help: 'Expired partial uploads reclaimed by cleanup',
    type: IMetricsComponent.CounterType
  },
  partial_upload_cleanup_runs: {
    help: 'Expired partial upload cleanup runs',
    type: IMetricsComponent.CounterType,
    // outcome=(success|deferred|error); deferred means the content lock stayed busy
    labelNames: ['outcome']
  },
  partial_upload_cleanup_duration_seconds: {
    help: 'Duration of expired partial upload cleanup runs',
    type: IMetricsComponent.HistogramType,
    buckets: [0.1, 0.5, 1, 5, 15, 30, 60, 120, 300]
  },
  partial_upload_cleanup_last_success_timestamp_seconds: {
    help: 'Unix time of the last cleanup run that completed',
    type: IMetricsComponent.GaugeType
  },
  garbage_collection_runs: {
    help: 'Garbage collection runs (POST /gc)',
    type: IMetricsComponent.CounterType,
    // outcome=(success|deferred|error); deferred means the content lock stayed busy
    labelNames: ['outcome']
  },
  garbage_collection_duration_seconds: {
    help: 'Duration of garbage collection runs',
    type: IMetricsComponent.HistogramType,
    buckets: [1, 5, 15, 60, 300, 900, 1800, 3600, 7200]
  },
  garbage_collection_last_success_timestamp_seconds: {
    help: 'Unix time of the last garbage collection run that completed',
    type: IMetricsComponent.GaugeType
  },
  garbage_collection_removed_keys: {
    help: 'Unreferenced storage keys deleted by garbage collection',
    type: IMetricsComponent.CounterType
  },
  content_lock_writer_timeouts: {
    help: 'Garbage collection or cleanup batches deferred because uploads kept the content lock busy',
    type: IMetricsComponent.CounterType
  },
  world_deployments_counter: {
    help: 'Count world deployments',
    type: IMetricsComponent.CounterType,
    labelNames: ['kind']
  },
  multipart_upload_reserved_bytes: {
    help: 'Bytes currently reserved by multipart uploads',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_capacity_bytes: {
    help: 'Capacity of the multipart in-flight upload budget (MAX_IN_FLIGHT_UPLOAD_BYTES)',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_active: {
    help: 'Multipart uploads currently being parsed or handled',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_orphaned_bytes: {
    help: 'Multipart upload bytes retained in temporary directories after cleanup failures',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_reserved_files: {
    help: 'Temporary files currently held by active and orphaned multipart uploads',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_orphaned_files: {
    help: 'Temporary files retained after multipart cleanup failures',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_orphaned_directories: {
    help: 'Temporary upload directories retained after multipart cleanup failures',
    type: IMetricsComponent.GaugeType
  },
  multipart_upload_rejections: {
    help: 'Multipart uploads rejected by the admission controller',
    type: IMetricsComponent.CounterType,
    labelNames: ['route', 'reason']
  },
  multipart_upload_unattributed: {
    help: 'Multipart uploads without a client source, so not bound by the per-source limits',
    type: IMetricsComponent.CounterType,
    labelNames: ['route']
  },
  multipart_upload_cleanup_failures: {
    help: 'Multipart upload directories whose initial cleanup attempt failed',
    type: IMetricsComponent.CounterType,
    labelNames: ['route']
  },
  multipart_upload_cleanup_retry_failures: {
    help: 'Failed background retry attempts to remove multipart upload directories',
    type: IMetricsComponent.CounterType,
    labelNames: ['route']
  },
  multipart_upload_size_bytes: {
    help: 'Actual parsed multipart upload size in bytes',
    type: IMetricsComponent.HistogramType,
    labelNames: ['route', 'content_length', 'outcome'],
    buckets: [1024, 1024 * 1024, 10 * 1024 * 1024, 100 * 1024 * 1024, 350 * 1024 * 1024]
  },
  deployment_processing_stage_duration_seconds: {
    help: 'Duration of deployment processing stages after multipart parsing',
    type: IMetricsComponent.HistogramType,
    labelNames: ['stage', 'outcome'],
    buckets: [0.01, 0.05, 0.1, 0.5, 1, 5, 15, 30, 60, 120, 300]
  },
  deployment_processing_stage_items: {
    help: 'Number of content items handled by each deployment processing stage',
    type: IMetricsComponent.HistogramType,
    labelNames: ['stage'],
    buckets: [1, 10, 100, 1000, 10000]
  },
  deployment_processing_stage_active: {
    help: 'Deployment requests currently executing each processing stage',
    type: IMetricsComponent.GaugeType,
    labelNames: ['stage']
  },
  deployment_processing_worker_active: {
    help: 'Workers currently active in each deployment processing stage',
    type: IMetricsComponent.GaugeType,
    labelNames: ['stage']
  },
  deployment_processing_failures: {
    help: 'Deployment processing stage failures by outcome',
    type: IMetricsComponent.CounterType,
    labelNames: ['stage', 'outcome']
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
