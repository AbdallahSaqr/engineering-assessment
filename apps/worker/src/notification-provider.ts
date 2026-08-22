export interface StatusNotification {
  idempotencyKey: string;
  recipient: string;
  customerName: string;
  applicationId: string;
  status: string;
}

export interface NotificationSender {
  sendStatusUpdate(notification: StatusNotification): Promise<void>;
}

export class MockEmailProvider implements NotificationSender {
  async sendStatusUpdate(notification: StatusNotification): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 75));

    if (notification.recipient.endsWith("@retry.invalid")) {
      throw new Error("mock provider is temporarily unavailable");
    }

    console.info(
      `[email] sent ${notification.status} update for ${notification.applicationId} to ${notification.recipient}`,
    );
  }
}
