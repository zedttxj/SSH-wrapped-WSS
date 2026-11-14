// lib/ssh-tunnel.ts
import { Connection } from 'ssh2';
import net from 'net';
import { POD_SSH_USER, POD_SSH_PASSWORD, SSH_HOST_KEY, DATABASE_HOST, DATABASE_PORT } from './config';
import fs from 'fs';

import { Server } from 'ssh2';

type statusType = 'CONNECTED' | 'CONNECTING' | 'DISCONNECTED' | 'ERROR';

// Global tracking variables for the SSH server state and active connections
let sshServer: Server | null = null;
const activeSshClients = new Set<Connection>();
const activeLocalServers = new Set<net.Server>();

let status: statusType = "DISCONNECTED";

export function getTunnelStatus() {
  return status;
}

export function setTunnelStatus() {
  status = activeLocalServers.size > 0 ? "CONNECTED" : "CONNECTING";
}

/**
 * START SSH BRIDGE:
 * Spins up an embedded SSH server to handle incoming reverse tunneling requests, 
 * authenticating clients using credentials defined in your config.
 */
export function startSshBridge() {
  if (sshServer) {
    console.log("[SSH Bridge] Server already running.");
    return sshServer;
  }
  status = 'CONNECTING';

  // Initialize the ssh2 Server with customized cryptographic algorithms and host keys
  sshServer = new Server(
    {
      hostKeys: [SSH_HOST_KEY || fs.readFileSync(".kube/.ssh/host_key")],
      debug: (msg) => console.log(msg),
      // Explicitly advertise supported algorithms to ensure compatibility with connecting SSH clients
      algorithms: {
        serverHostKey: [
          'ssh-ed25519',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',
        ],
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        cipher: [
          'aes128-ctr',
          'aes192-ctr',
          'aes256-ctr',
          'aes128-gcm@openssh.com',
          'aes256-gcm@openssh.com',
        ],
      },
    },
    (client) => {
      activeSshClients.add(client);
      console.log('[SSH Bridge] Incoming TCP connection...' + '(username should be: ' + POD_SSH_USER);

      // Handle SSH client authentication requests (checking username and password)
      client.on('authentication', (ctx) => {
        console.log('[SSH Bridge] Authentication...');
        if (ctx.username !== POD_SSH_USER) {
          return ctx.reject(['password']);
        }

        if (ctx.method === 'password' && ctx.password === POD_SSH_PASSWORD) {
          console.log(`[SSH Bridge] Password auth succeeded for user: ${ctx.username}`);
          return ctx.accept();
        }

        return ctx.reject(['password']);
      });

      // Once authenticated, handle port forwarding requests
      client.on('ready', () => {
        status = "CONNECTED";
        console.log('[SSH Bridge] Authenticated! Ready for reverse tunnel.');

        client.on('request', (accept, reject, name, info) => {
          if (name === 'tcpip-forward') {
            if (accept) accept();
            status = "CONNECTED";
            console.log(`[SSH Bridge] Status updated to CONNECTED on port ${info.bindPort}`);

            // Create a local TCP proxy server to forward traffic through the tunnel
            const localServer = net.createServer((incomingSocket) => {
              const srcPort = incomingSocket.remotePort || Math.floor(10000 + Math.random() * 50000);
              console.log(`[SSH Bridge] Connection from local port ${srcPort} -> Forwarding to OpenSSH listener 127.0.0.1:2525`);
              client.forwardOut(
                '127.0.0.1',
                info.bindPort,
                '127.0.0.1',
                srcPort,
                (err, stream) => {
                  if (err) return incomingSocket.destroy();

                  // Pipe data bi-directionally between the local socket and the SSH stream
                  incomingSocket.pipe(stream);
                  stream.pipe(incomingSocket);

                  incomingSocket.on('error', () => stream.end());
                  stream.on('error', () => incomingSocket.destroy());
                }
              );
            });

            localServer.on('error', (err: any) => {
              if (err.code === 'EADDRINUSE') {
                console.error(`[SSH Bridge] Port ${info.bindPort} is already in use. Cleaning up stale listener...`);
                localServer.close();
              } else {
                console.error('[SSH Bridge] Local server error:', err);
              }
            });

            localServer.listen(info.bindPort, '127.0.0.1', () => {
              console.log(`[SSH Bridge] Local bridge active on 127.0.0.1:${info.bindPort}`);
            });

            activeLocalServers.add(localServer);

            client.on('close', () => {
              localServer.close();
              activeLocalServers.delete(localServer);
            });
          } else {
            if (reject) reject();
          }
        });
      });

      // Cleanup tracking when an SSH client drops connection
      client.on('close', () => {
        activeSshClients.delete(client);
        if (activeSshClients.size === 0) {
          status = 'DISCONNECTED';
        }
      });
    }
  );
}

// Target database configuration endpoints on the remote side of the SSH tunnel
const TARGET_DB_HOST = DATABASE_HOST || '127.0.0.1';
const TARGET_DB_PORT = parseInt(DATABASE_PORT, 10);

/**
 * START SSH DATABASE TUNNEL:
 * Alternative setup focused specifically on proxying direct database traffic through an established SSH tunnel.
 */
export function startSshDB() {
  if (sshServer) {
    console.log("[SSH Bridge] Server already running.");
    return sshServer;
  }
  status = 'CONNECTING';
  sshServer = new Server(
    {
      hostKeys: [SSH_HOST_KEY || fs.readFileSync(".kube/.ssh/host_key")],
      debug: (msg) => console.log(msg),
      // Explicitly advertise host key algorithms so OpenSSH sees them in "Their offer:"
      algorithms: {
        serverHostKey: [
          'ssh-ed25519',
          'rsa-sha2-512',
          'rsa-sha2-256',
          'ssh-rsa',
        ],
        kex: [
          'ecdh-sha2-nistp256',
          'ecdh-sha2-nistp384',
          'ecdh-sha2-nistp521',
          'diffie-hellman-group14-sha256',
          'diffie-hellman-group14-sha1',
        ],
        cipher: [
          'aes128-ctr',
          'aes192-ctr',
          'aes256-ctr',
          'aes128-gcm@openssh.com',
          'aes256-gcm@openssh.com',
        ],
      },
    },
    (client) => {
      activeSshClients.add(client);
      console.log('[SSH Bridge] Incoming TCP connection...' + '(username should be: ' + POD_SSH_USER);

      client.on('authentication', (ctx) => {
        console.log('[SSH Bridge] Authentication...');
        if (ctx.username !== POD_SSH_USER) {
          return ctx.reject(['password']);
        }

        if (ctx.method === 'password' && ctx.password === POD_SSH_PASSWORD) {
          console.log(`[SSH Bridge] Password auth succeeded for user: ${ctx.username}`);
          return ctx.accept();
        }

        return ctx.reject(['password']);
      });

      client.on('ready', () => {
        status = "CONNECTED";
        console.log(`[SSH Bridge] WS-SSH Authenticated! Starting TCP Gateway on 0.0.0.0:${TARGET_DB_PORT}...`);

        // Open an outbound TCP connection from inside the container to the actual database host/port
        client.on('tcpip', (accept, reject, _info) => {
          // const destHost = info.destIP;
          // const destPort = info.destPort;
          const destHost = TARGET_DB_HOST;
          const destPort = TARGET_DB_PORT;

          console.log(`[SSH Bridge] Direct TCP request: Client wants -> ${destHost}:${destPort}`);

          // Open outbound TCP connection from inside the Next.js K8s pod to the DB
          const dbSocket = net.connect(destPort, destHost, () => {
            console.log(`[SSH Bridge] Connected to DB at ${destHost}:${destPort}. Accepting SSH channel...`);
            const sshChannel = accept(); // Accept and return the ServerChannel stream

            // Bi-directional pipe: SSH Tunnel Stream <---> Outbound DB TCP Socket
            // Bi-directional pipe: Connects the SSH tunnel stream directly to the target database socket
            sshChannel.pipe(dbSocket);
            dbSocket.pipe(sshChannel);

            sshChannel.on('error', (err: any) => {
              console.error('[SSH Bridge] SSH Channel error:', err);
              dbSocket.destroy();
            });

            dbSocket.on('error', (err) => {
              console.error('[SSH Bridge] Target DB socket error:', err);
              sshChannel.end();
            });
          });

          dbSocket.on('error', (err) => {
            console.error(`[SSH Bridge] Could not connect to target DB ${destHost}:${destPort}:`, err);
            if (reject) reject();
          });
        });
      });

      // Cleanup when SSH client drops
      client.on('close', () => {
        activeSshClients.delete(client);
        if (activeSshClients.size === 0) {
          status = 'DISCONNECTED';
        }
      });
    }
  );
}

/**
 * STOP SSH BRIDGE:
 * Gracefully shuts down all local proxy servers, active client sessions, 
 * and closes the main embedded SSH server instance.
 */
export function stopSshBridge(): Promise<void> {
  console.log('[Stop Bridge] Beginning shutdown sequence...');
  status = 'DISCONNECTED';

  // 1. Close all active local TCP proxy servers
  console.log(`[Stop Bridge] Closing ${activeLocalServers.size} active local TCP proxy server(s)...`);
  activeLocalServers.forEach((localServer, index) => {
    try {
      localServer.close(() => {
        console.log(`[Stop Bridge] Local proxy server #${index} closed successfully.`);
      });
      if (typeof (localServer as any).closeAllConnections === 'function') {
        (localServer as any).closeAllConnections();
      }
    } catch (e) {
      console.error(`[Stop Bridge ERROR] Failed to close local proxy server #${index}:`, e);
    }
  });
  activeLocalServers.clear();

  // 2. Terminate active SSH client sessions
  console.log(`[Stop Bridge] Terminating ${activeSshClients.size} active SSH client session(s)...`);
  activeSshClients.forEach((client, index) => {
    try {
      client.end();
      console.log(`[Stop Bridge] SSH client #${index} destroyed.`);
    } catch (e) {
      console.error(`[Stop Bridge ERROR] Failed to destroy SSH client #${index}:`, e);
    }
  });
  activeSshClients.clear();

  // 3. Close the main background SSH server instance
  return new Promise((resolve) => {
    if (sshServer) {
      console.log('[Stop Bridge] Attempting to close main sshServer instance...');
      try {
        sshServer.close(() => {
          console.log('[Stop Bridge] Main sshServer closed callback fired successfully.');
          sshServer = null;
          resolve();
        });
      } catch (e) {
        console.error('[Stop Bridge ERROR] Exception thrown while closing main sshServer:', e);
        sshServer = null;
        resolve();
      }
    } else {
      console.log('[Stop Bridge] Main sshServer was already null/closed.');
      resolve();
    }
  });
}

export function yourSshServerSetup() {
  return sshServer;
}

