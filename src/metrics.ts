import { IMetricsComponent } from '@well-known-components/interfaces'
import { metricDeclarations as logMetricDeclarations } from '@well-known-components/logger'
import { getDefaultHttpMetrics, validateMetricsDeclaration } from '@well-known-components/metrics'
import { metricDeclarations as theGraphMetricDeclarations } from '@well-known-components/thegraph-component'

export const metricDeclarations = {
  ...getDefaultHttpMetrics(),
  ...logMetricDeclarations,
  ...theGraphMetricDeclarations,
  world_deployments_counter: {
    help: 'Count world deployments',
    type: IMetricsComponent.CounterType,
    labelNames: []
  }
}

// type assertions
validateMetricsDeclaration(metricDeclarations)
