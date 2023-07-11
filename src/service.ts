import { Lifecycle } from '@well-known-components/interfaces'
import { setupRouter } from './controllers/routes'
import { AppComponents, GlobalContext, TestComponents } from './types'
import { bufferToStream, streamToBuffer } from '@dcl/catalyst-storage'
import { stringToUtf8Bytes } from 'eth-connect'

// this function wires the business logic (adapters & controllers) with the components (ports)
export async function main(program: Lifecycle.EntryPointParameters<AppComponents | TestComponents>) {
  const { components, startComponents } = program
  const globalContext: GlobalContext = {
    components
  }

  // wire the HTTP router (make it automatic? TBD)
  const router = await setupRouter(globalContext)
  // register routes middleware
  components.server.use(router.middleware())
  // register not implemented/method not allowed/cors responses middleware
  components.server.use(router.allowedMethods())
  // set the context to be passed to the handlers
  components.server.setContext(globalContext)

  // start ports: db, listeners, synchronizations, etc
  await startComponents()

  async function readFile(key: string): Promise<object | undefined> {
    const content = await components.storage.retrieve(key)
    if (!content) {
      return undefined
    }
    return JSON.parse((await streamToBuffer(await content.asStream())).toString())
  }

  async function writeFile(key: string, content: object) {
    console.log(`Writing "${key}"`, JSON.stringify(content))
    await components.storage.storeStream(key, bufferToStream(stringToUtf8Bytes(JSON.stringify(content))))
  }

  // Fix incorrectly stored ACLs
  for await (const key of await components.storage.allFileIds('name-')) {
    if (key.startsWith('name-') && key.endsWith('.dcl.eth')) {
      if (key.toLowerCase() !== key) {
        console.log(`Found "${key}" that needs to be fixed`)
        const existing = await readFile(key)
        const toBeModified = (await readFile(key.toLowerCase())) || {}
        console.log({ existing, toBeModified })
        await writeFile(key.toLowerCase(), {
          ...existing,
          ...toBeModified
        })
        await components.storage.delete([key])
      }
    }
  }
}
