import { IHttpServerComponent } from '@dcl/core-commons'
import { HandlerContextWithPath } from '../../types'
import { EthAddress } from '@dcl/schemas'
import { InvalidRequestError, NotAuthorizedError } from '@dcl/http-commons'
import { DecentralandSignatureContext } from '@dcl/crypto-middleware'

export async function walletRecheckHandler({
  params,
  components: { walletStats },
  verification
}: HandlerContextWithPath<'walletStats', '/wallet/:wallet/recheck-blocked'> &
  DecentralandSignatureContext<any>): Promise<IHttpServerComponent.IResponse> {
  const wallet = params.wallet

  if (!wallet || !EthAddress.validate(wallet)) {
    throw new InvalidRequestError('Invalid request. Missing or invalid wallet in request url param.')
  }

  const signer = verification!.auth.toLowerCase()
  if (signer !== wallet.toLowerCase()) {
    throw new NotAuthorizedError('Unauthorized. You can only recheck blocked status for your own wallet.')
  }

  const { unblocked, stats } = await walletStats.clearBlockedIfUnderQuota(wallet)

  return {
    status: 200,
    body: {
      blocked: !unblocked && !!stats.blockedSince,
      unblocked,
      usedSpace: stats.usedSpace.toString(),
      maxAllowedSpace: stats.maxAllowedSpace.toString()
    }
  }
}
