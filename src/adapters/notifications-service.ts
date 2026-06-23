import { AppComponents, Notification, INotificationService } from '../types'

export async function createNotificationsClientComponent({
  config,
  fetch,
  logs
}: Pick<AppComponents, 'config' | 'fetch' | 'logs'>): Promise<INotificationService> {
  const notificationServiceUrl = await config.getString('NOTIFICATION_SERVICE_URL')
  if (!!notificationServiceUrl) {
    return createHttpNotificationClient({ config, fetch, logs })
  }

  return createLogNotificationClient({ logs })
}

async function createHttpNotificationClient({
  config,
  fetch,
  logs
}: Pick<AppComponents, 'config' | 'fetch' | 'logs'>): Promise<INotificationService> {
  const logger = logs.getLogger('http-notifications-client')
  const [notificationServiceUrl, authToken] = await Promise.all([
    config.getString('NOTIFICATION_SERVICE_URL'),
    config.getString('NOTIFICATION_SERVICE_TOKEN')
  ])

  if (!!notificationServiceUrl && !authToken) {
    throw new Error('Notification service URL provided without a token')
  }
  logger.info(`Using notification service at ${notificationServiceUrl}`)

  async function sendNotifications(notifications: Notification[]): Promise<void> {
    logger.info(`Sending ${notifications.length} notifications`, { notifications: JSON.stringify(notifications) })
    const response = await fetch.fetch(`${notificationServiceUrl}/notifications`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${authToken}`
      },
      body: JSON.stringify(notifications)
    })
    // The response is not used; drain its body so undici can release the
    // connection back to its pool instead of leaving it pinned until GC.
    await response.body?.cancel().catch(() => undefined)
  }

  return {
    sendNotifications
  }
}

async function createLogNotificationClient({ logs }: Pick<AppComponents, 'logs'>): Promise<INotificationService> {
  const logger = logs.getLogger('log-notifications-client')
  return {
    async sendNotifications(notifications: Notification[]): Promise<void> {
      logger.info(`Sending ${notifications.length} notifications`, { notifications: JSON.stringify(notifications) })
    }
  }
}
