import { NextApiRequest, NextApiResponse } from "next";
import {
  getTunnelStatus,
  setTunnelStatus,
  stopSshBridge,
  startSshDB,
  yourSshServerSetup,
} from "@/lib/ssh-tunnel";

import { Duplex } from "stream";
import { WebSocketServer } from "ws";
import { parse } from "url";
import { validateLocalSessionSync } from "@/lib/session-utils";

// Prevent duplicate WebSocket servers during Next.js Hot Module Reloads (HMR)
declare global {
  var wss: WebSocketServer | undefined;
  var sshServerInstance: any | undefined;
}

let activeUpgradeHandler:
  ((request: any, socket: any, head: any) => void) | null = null;

const createUpgradeHandler = (_server: any) => {
  return (request: any, socket: Duplex, head: Buffer) => {
    const parsedUrl = parse(request.url || "", true);
    const cleanPath = parsedUrl.pathname?.replace(/\/$/, "");

    if (cleanPath === "/a/b/c/d") {
      const authHeader = request.headers["authorization"];
      let token: string | null = null;

      if (authHeader && authHeader.startsWith("Bearer ")) {
        token = authHeader.split(" ")[1];
      }
      const username = token ? validateLocalSessionSync(token) : null;
      if (!username) {
        console.warn(
          "[SSH Bridge] Rejected WebSocket upgrade: Invalid or missing session token.",
        );
        socket.write(
          "HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\nUnauthorized Session",
        );
        socket.destroy();
        return;
      }

      const activeWss = globalThis.wss;
      const activeSshServer = globalThis.sshServerInstance;

      if (!activeSshServer || !activeWss) {
        socket.destroy();
        return;
      }

      activeWss.handleUpgrade(request, socket, head, (ws) => {
        activeWss.emit("connection", ws, request);
      });
    }
  };
};

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    return res.status(200).json({ message: getTunnelStatus() });
  } else if (req.method === "POST") {
    try {
      const { action } =
        typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      if (!action) {
        return res.status(400).json({
          error: "Missing required fields: 'action' is required",
        });
      }
      if (action === "stop") {
        await stopSshBridge();
        if (globalThis.sshServerInstance) {
          try {
            // Check if it has a close method (standard for net.Server / ssh2 servers)
            if (typeof globalThis.sshServerInstance.close === "function") {
              globalThis.sshServerInstance.close();
            }
          } catch (e) {
            console.error("[SSH Bridge] Error closing sshServerInstance:", e);
          }
          globalThis.sshServerInstance = undefined;
        }

        // Close all active WebSocket connections and shut down the WebSocketServer
        if (globalThis.wss) {
          console.log("[SSH Bridge] Closing WebSocket server...");
          globalThis.wss.clients.forEach((client) => {
            try {
              client.terminate();
            } catch (e) {}
          });
          globalThis.wss.close();
          globalThis.wss = undefined;
        }
        // await stopSshBridge();
        const server = (res.socket as any).server;
        if (activeUpgradeHandler && server) {
          server.removeListener("upgrade", activeUpgradeHandler);
          activeUpgradeHandler = null;
        }
      }
      if (action === "start") {
        // startSshBridge();
        startSshDB();
        globalThis.sshServerInstance = yourSshServerSetup();

        // Access Node's raw HTTP server from the Next.js request socket
        const server = (res.socket as any).server;
        if (activeUpgradeHandler && server) {
          server.removeListener("upgrade", activeUpgradeHandler);
          activeUpgradeHandler = null;
        }

        if (!globalThis.wss) {
          console.log(
            "[SSH Bridge] Attaching WebSocket server to Next.js HTTP instance...",
          );
          const wss = new WebSocketServer({ noServer: true });
          globalThis.wss = wss;
        }

        activeUpgradeHandler = createUpgradeHandler(server);
        server.on("upgrade", activeUpgradeHandler);

        globalThis.wss.on("connection", (ws) => {
          console.log("[SSH Bridge] Client connected over WebSocket");

          const clientSocket: any = new Duplex({
            read(_size) {},
            write(chunk, _encoding, callback) {
              if (ws.readyState === ws.OPEN) {
                console.log(
                  `[SSH Bridge] Outgoing bytes to client: ${chunk.length}`,
                );
                ws.send(chunk, callback);
              }
            },
          });

          // Polyfills required by ssh2
          clientSocket.remoteAddress = "127.0.0.1";
          clientSocket.remotePort = 22;
          clientSocket.localAddress = "127.0.0.1";
          clientSocket.localPort = 3000;
          clientSocket.connecting = false;
          clientSocket.ready = true;
          clientSocket.destroy = () => {
            ws.close();
            return clientSocket;
          };
          clientSocket.cork = () => {};
          clientSocket.uncork = () => {};
          clientSocket.setTimeout = () => {};
          clientSocket.setKeepAlive = () => {};
          clientSocket.setNoDelay = () => {};

          if (globalThis.sshServerInstance) {
            // Use ssh2's native injection method!
            globalThis.sshServerInstance.injectSocket(clientSocket);
          } else {
            console.error("[SSH Bridge] sshServerInstance is null!");
            ws.close();
            return;
          }

          // Route incoming WebSocket messages directly into clientSocket
          ws.on("message", (data: any) => {
            const buffer = Buffer.isBuffer(data)
              ? data
              : Array.isArray(data)
                ? Buffer.concat(data)
                : Buffer.from(data as ArrayBuffer);

            console.log(
              `[SSH Bridge] Incoming bytes from client: ${buffer.length}`,
            );

            // Push the raw bytes into the readable side so ssh2's parser picks them up
            clientSocket.push(buffer);
          });

          ws.on("close", (code, reason) => {
            console.log(
              `[WS Close] WebSocket closed by client/server. Code: ${code}, Reason: ${reason?.toString()}`,
            );
            setTunnelStatus();
            clientSocket.push(null);
          });

          ws.on("error", (err) => {
            console.error("[WS Error]:", err);
            setTunnelStatus();
            clientSocket.destroy(err);
          });
        });
      }
      return res.status(200).json({ message: getTunnelStatus() });
    } catch (error) {
      console.error("[Admin Tunnel API Error]:", error);
      return res.status(500).json({ error: "Failed to toggle tunnel" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
