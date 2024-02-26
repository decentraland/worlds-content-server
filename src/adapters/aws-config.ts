import { AppComponents, AwsConfig } from '../types'

export async function createAwsConfig({ config }: Pick<AppComponents, 'config'>): Promise<AwsConfig> {
  const awsConfig: AwsConfig = {
    region: await config.requireString('AWS_REGION')
  }
  const accessKeyId = await config.getString('AWS_ACCESS_KEY_ID')
  const secretAccessKey = await config.getString('AWS_SECRET_ACCESS_KEY')
  if (accessKeyId && secretAccessKey) {
    awsConfig.credentials = {
      accessKeyId: (await config.getString('AWS_ACCESS_KEY_ID')) || '',
      secretAccessKey: (await config.getString('AWS_SECRET_ACCESS_KEY')) || ''
    }
  }
  const awsEndpoint = await config.getString('AWS_ENDPOINT')
  if (awsEndpoint) {
    awsConfig.endpoint = awsEndpoint
    awsConfig.forcePathStyle = true
    awsConfig.s3ForcePathStyle = true
  }

  return awsConfig
}
