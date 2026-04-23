import http from 'node:http';
import { createApp } from './app.js';
import { env } from './env.js';
import { logger } from './logger.js';
import { startFanout } from './realtime/pgFanout.js';
import { attachRealtime } from './realtime/socket.js';
import {
  setScheduledBroadcaster,
  startScheduledMessageTicker,
} from './services/scheduledMessages.js';

async function main(): Promise<void> {
  const app = createApp();
  const server = http.createServer(app);
  await startFanout();
  attachRealtime(server);

  setScheduledBroadcaster({
    broadcastMessageVisible: async (m) => {
      const { publish } = await import('./realtime/pgFanout.js');
      await publish({
        type: 'message:new',
        conversationId: m.conversationId,
        messageId: m.id,
        senderId: null,
        senderExternalIdentityId: null,
        urgent: false,
        createdAt: new Date().toISOString(),
      });
    },
  });
  startScheduledMessageTicker();

  server.listen(env.port, () => {
    logger.info('server.listening', { port: env.port, env: env.nodeEnv });
  });
}

void main();
