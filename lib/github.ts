import { TARGET_ORG } from "./config";

export async function verifyGitHubToken({
  github_token,
}: {
  github_token: string;
}): Promise<{ profile: any }> {
  try {
    // Since the CLI already handled the Device Flow trade,
    // we go straight to fetching and verifying the user profile with the token.
    const profileResponse = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${github_token}`,
        "User-Agent": "Custom-CLI-App",
      },
    });

    if (!profileResponse.ok) {
      throw new Error(`Failed to fetch user profile: ${profileResponse.statusText}`);
    }

    const profile = await profileResponse.json();

    if (!profile || !profile.id) {
      throw new Error("Verification payload missing profile attributes.");
    }

    return { profile };
  } catch (error) {
    console.error("Error validating GitHub token:", error);
    throw new Error("Invalid GitHub token");
  }
}

export async function verifyGitHubOrganization(
  githubAccessToken: string,
  username: string
): Promise<boolean> {
  try {
    // Check if the user is a member of the specific GitHub organization
    const response = await fetch(`https://api.github.com/orgs/${TARGET_ORG}/members/${username}`, {
      headers: {
        Authorization: `Bearer ${githubAccessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "SSH-Tunnel-Auth-Service",
      },
    });

    // GitHub returns 204 No Content if the user is a public/private member of the org
    return response.status === 204;
  } catch (err) {
    console.error("Failed to verify GitHub organization membership:", err);
    return false;
  }
}

