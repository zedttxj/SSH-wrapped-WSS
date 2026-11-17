import { verifyGitHubOrganization, verifyGitHubToken } from "@/lib/github"; // Update import path to where your token verification function lives
import {
  createLocalSessionSync,
  validateLocalSessionSync,
} from "@/lib/session-utils";
import { NextApiRequest, NextApiResponse } from "next";
import z from "zod";

export const maxDuration = 5; // Disable Next.js API route timeout

const TokenExchangeSchema = z.object({
  github_token: z.string().min(1, "GitHub token is required"),
});

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse,
) {
  if (req.method === "GET") {
    const authHeader = req.headers.authorization;
    let token: string | null = null;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      token = authHeader.split(" ")[1];
    }
    const username = token ? validateLocalSessionSync(token) : null;
    return res.status(username ? 200 : 401).json({});

    // 1. Must be a POST request matching your CLI curl call
  } else if (req.method === "POST") {
    try {
      const parseResult = TokenExchangeSchema.safeParse(
        typeof req.body === "string" ? JSON.parse(req.body) : req.body,
      );

      if (!parseResult.success) {
        return res.status(400).json({
          error: "Invalid request body",
          details: parseResult.error.issues,
        });
      }

      const { github_token } = parseResult.data;

      const { profile } = await verifyGitHubToken({ github_token });

      const username = profile?.login;

      if (!username) {
        return res
          .status(401)
          .json({ error: "Unauthorized: GitHub profile missing username" });
      }

      const isMember = await verifyGitHubOrganization(github_token, username);
      if (!isMember) {
        console.warn(
          `[Security] Access denied for @${username}: Not a member of the required organization.`,
        );
        return res.status(403).json({
          error:
            "Forbidden: You are not a member of the required organization.",
        });
      }

      const sessionToken = createLocalSessionSync(username);

      return res.status(200).json({
        success: true,
        session_token: sessionToken,
        ssh_user: username,
      });
    } catch (error) {
      console.error("GitHub token exchange error:", error);
      return res.status(403).json({ error: "GitHub Authentication Failed" });
    }
  } else {
    return res.status(405).json({ error: "Method not allowed" });
  }
}
