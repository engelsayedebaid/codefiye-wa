import { buildApp } from './app';
import { config } from './config';

const app = await buildApp();
await app.listen({ port: config.port, host: config.host });

for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, async () => {
    await app.close();
    process.exit(0);
  });
