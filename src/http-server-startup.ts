import type { Server } from 'http';

/**
 * Wait until a webhook HTTP server is actually accepting connections.
 * Startup errors must reject the platform startup task instead of becoming an
 * unobserved EventEmitter error after the caller has reported success.
 */
export function listenHttpServer(server: Server, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port);
  });
}
