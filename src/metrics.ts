import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics } from '@dcl/http-server'
import { validateMetricsDeclaration } from '@well-known-components/metrics'
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
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
