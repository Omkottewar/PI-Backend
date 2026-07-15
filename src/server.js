import app from './app.js';
import { assertConfig, config } from './config/index.js';
import { createServer } from 'http';
import {
  startExpiryScheduler,
  startExpiryCountdownScheduler,
  startCallLogsCleanupScheduler,
} from './services/scheduler.service.js';

assertConfig();

// Start database auto-expiry scheduling
startExpiryScheduler();
// Start last-7-days SMS countdown to owners whose QR is about to expire.
startExpiryCountdownScheduler();
// Mark stale in-progress call_logs as timeout every 30 min.
startCallLogsCleanupScheduler();

const httpServer = createServer(app);

httpServer.listen(config.port, () => {
  console.log(`Emergency Alert API listening on http://localhost:${config.port}`);
});
