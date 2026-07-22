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
  world_deployments_counter: {
    help: 'Count world deployments',
    type: IMetricsComponent.CounterType,
    labelNames: ['kind']
  },
  multipart_upload_reserved_bytes: {
    help: 'Bytes currently reserved by multipart uploads',
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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
