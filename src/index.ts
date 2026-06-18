import { Lifecycle } from '@well-known-components/interfaces'
import { initComponents } from './components'
import { main } from './service'

// Defensive backstop: a stray unhandled promise rejection should be logged and
// observed, not silently crash the whole server (which would drop every in-flight
// request and rely on the orchestrator to restart). Known failure modes are fixed
// at their source in the relevant adapters; this catches anything not yet handled.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (process kept alive):', reason)
})

// This file is the program entry point, it only calls the Lifecycle function
void Lifecycle.run({ main, initComponents })
