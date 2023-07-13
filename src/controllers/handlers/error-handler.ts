import { IHttpServerComponent } from '@well-known-components/interfaces'
import { ErrorResponse, InvalidRequestError, NotFoundError } from '../../types'

function handleError(url: URL, error: any): { status: number; body: ErrorResponse } {
  if (error instanceof InvalidRequestError) {
    return {
      status: 400,
      body: {
        error: 'Bad request',
        message: error.message
      }
    }
  }

  if (error instanceof NotFoundError) {
    return {
      status: 404,
      body: {
        error: 'Not Found',
        message: error.message
      }
    }
  }

  console.log(`Error handling ${url.toString()}: ${error.message}`)
  return {
    status: 500,
    body: {
      error: 'Internal Server Error',
      message: error.message
    }
  }
}

export async function errorHandler(
  ctx: IHttpServerComponent.DefaultContext<object>,
  next: () => Promise<IHttpServerComponent.IResponse>
): Promise<IHttpServerComponent.IResponse> {
  try {
    return await next()
  } catch (error: any) {
    return handleError(ctx.url, error)
  }
}
