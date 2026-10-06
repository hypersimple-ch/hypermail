import { channel } from 'node:diagnostics_channel';

// The pinned vendor CLI owns its HTTP server privately and has no signal handler.
// Observe the public Node channel; never patch vendor code or force a successful exit.
const servers = new Set();
const sockets = new Set();
let httpDrained = false;
channel('net.client.socket').subscribe(({ socket }) => {
  sockets.add(socket);
  socket.once('close', () => { sockets.delete(socket); });
  if (httpDrained) socket.end();
});
channel('http.server.request.start').subscribe(({ server }) => {
  if (servers.has(server)) return;
  servers.add(server);
  server.once('close', () => { servers.delete(server); });
});

let stopping = false;
const stop = async () => {
  if (stopping) return;
  stopping = true;
  const deadline = setTimeout(() => {
    process.stderr.write('Hypermail shutdown did not drain all runtime resources\n');
    process.exit(1);
  }, 40_000);
  deadline.unref();
  // Production quiescence requires a healthy stack; its HTTP probe discovers the server.
  if (servers.size === 0) {
    process.stderr.write('Hypermail shutdown has no observed HTTP server\n');
    process.exit(1);
  }
  try {
    const closing = [];
    for (const server of servers) {
      closing.push(new Promise((resolve, reject) => {
        server.close(error => { if (error) reject(error); else resolve(); });
        server.closeIdleConnections();
      }));
    }
    await Promise.all(closing);
    httpDrained = true;
    // Provider requests are complete. Gracefully end idle HTTP/IMAP transport sockets
    // without destroying a pending write; remaining filesystem work drains naturally.
    for (const socket of sockets) socket.end();
    // Unknown listeners/background writers keep the loop alive and fail the deadline.
    process.exitCode ??= 0;
  } catch {
    process.stderr.write('Hypermail HTTP shutdown failed\n');
    process.exit(1);
  }
};
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });
