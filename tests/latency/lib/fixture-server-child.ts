// Child-process entry for the fixture website. Running it in its own process
// keeps server-side work off the event loop that is being measured, the way a
// real remote site would be.

import { compactPage, largePage, smallPage } from './fixtures.js';
import { startFixtureServer } from './fixture-server.js';

if (!process.send) {
  console.error('fixture-server-child must be started with an IPC channel (child_process.fork)');
  process.exit(2);
}

const fixture = await startFixtureServer({ '/small': smallPage(), '/compact': compactPage(), '/large': largePage() });
process.send({ type: 'ready', baseUrl: fixture.baseUrl });

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await fixture.close();
  process.exit(0);
};
process.on('message', (msg: { type?: string }) => {
  if (msg?.type === 'stop') void stop();
});
// Parent died or closed the channel: never linger as an orphan.
process.on('disconnect', () => void stop());
