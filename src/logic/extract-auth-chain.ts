import { FormDataContext } from './multipart'
import { AuthChain } from '@dcl/schemas'
import { requireString } from '../controllers/handlers/deploy-entity-handler'

export function extractAuthChain(ctx: FormDataContext): AuthChain {
  const ret: AuthChain = []

  let biggestIndex = -1

  // find the biggest index
  for (const i in ctx.formData.fields) {
    const regexResult = /authChain\[(\d+)]/.exec(i)
    if (regexResult) {
      biggestIndex = Math.max(biggestIndex, +regexResult[1])
    }
  }

  if (biggestIndex === -1) throw new Error('Missing auth chain')
  // fill all the authChain
  for (let i = 0; i <= biggestIndex; i++) {
    ret.push({
      payload: requireString(ctx.formData.fields[`authChain[${i}][payload]`].value),
      signature: requireString(ctx.formData.fields[`authChain[${i}][signature]`].value),
      type: requireString(ctx.formData.fields[`authChain[${i}][type]`].value) as any
    })
  }

  return ret
}
