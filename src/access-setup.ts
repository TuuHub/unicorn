// Onboarding step "Sign in with email": sets up Cloudflare Access on the owner's own account.
//
// The owner pastes an API token made from TOKEN_URL (Access apps and Access account settings, edit;
// Account Settings, read, without which /accounts comes back empty) and
// their email. unicorn uses the token for these calls and never stores it:
//
//   1. find the one account the token reaches
//   2. find the Zero Trust organization (team domain), or create one
//   3. make sure the one-time PIN login method exists
//   4. create or update the "unicorn" application on <host>/login/access, letting in that email
//
// Only /login/access is behind Access, never the whole Worker: client apps must reach /mcp and the
// OAuth endpoints without a browser.

import { ACCESS_LOGIN_PATH, type AccessConfig } from "./access";

const API = "https://api.cloudflare.com/client/v4";

/** Prefills a user API token with Access apps (edit), Access account settings (edit) and Account Settings (read). */
export const TOKEN_URL = `https://dash.cloudflare.com/profile/api-tokens?permissionGroupKeys=${encodeURIComponent(
  JSON.stringify([
    { key: "access", type: "edit" },
    { key: "access_acct", type: "edit" },
    { key: "account_settings", type: "read" },
  ]),
)}&accountId=*&zoneId=all&name=${encodeURIComponent("unicorn email sign-in")}`;

export class AccessSetupError extends Error {}

interface ApiResult<T> {
  success?: boolean;
  result?: T;
  errors?: { code?: number; message?: string }[];
}

interface AccessApp {
  id: string;
  aud: string;
  domain?: string;
  self_hosted_domains?: string[];
}

export async function setUpAccessLogin(input: { apiToken: string; email: string; host: string; fetch?: typeof fetch }): Promise<AccessConfig> {
  const fetcher = input.fetch ?? fetch;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const response = await fetcher(`${API}${path}`, {
      method,
      headers: { authorization: `Bearer ${input.apiToken}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await response.json().catch(() => ({}))) as ApiResult<T>;
    if (!response.ok || !data.success || data.result === undefined) {
      const message = data.errors?.[0]?.message ?? `HTTP ${response.status}`;
      throw new ApiError(response.status, message);
    }
    return data.result;
  };

  let accounts: { id: string; name: string }[];
  try {
    accounts = await call("GET", "/accounts?per_page=50");
  } catch (error) {
    throw new AccessSetupError(error instanceof ApiError && (error.status === 401 || error.status === 403) ? "Cloudflare didn't accept that API token. Check you copied all of it." : `Cloudflare said: ${errorText(error)}`);
  }
  if (accounts.length !== 1) {
    throw new AccessSetupError(
      accounts.length
        ? `That token reaches ${accounts.length} accounts. Make it again and include only the account unicorn runs on.`
        : "That token can't see your account. Make it from the link so all three permissions are filled in.",
    );
  }
  const account = `/accounts/${accounts[0]!.id}/access`;

  const teamDomain = await organization(call, account, accounts[0]!.id);

  const providers = await call<{ id: string; type: string }[]>("GET", `${account}/identity_providers`).catch(permissionError);
  const pin = providers.find((provider) => provider.type === "onetimepin") ?? (await call<{ id: string }>("POST", `${account}/identity_providers`, { name: "One-time PIN", type: "onetimepin", config: {} }).catch(permissionError));

  const domain = `${input.host}${ACCESS_LOGIN_PATH}`;
  const apps = await call<AccessApp[]>("GET", `${account}/apps?per_page=100`).catch(permissionError);
  const existing = apps.find((app) => app.domain === domain || app.self_hosted_domains?.includes(domain));
  const definition = {
    name: "unicorn",
    type: "self_hosted",
    domain,
    destinations: [{ type: "public", uri: domain }],
    session_duration: "720h",
    app_launcher_visible: false,
    allowed_idps: [pin.id],
    auto_redirect_to_identity: true,
    policies: [{ name: "Owner", decision: "allow", include: [{ email: { email: input.email } }] }],
  };
  const app = existing
    ? await call<AccessApp>("PUT", `${account}/apps/${existing.id}`, definition).catch(permissionError)
    : await call<AccessApp>("POST", `${account}/apps`, definition).catch(permissionError);
  return { teamDomain, aud: app.aud, email: input.email };
}

type Call = <T>(method: string, path: string, body?: unknown) => Promise<T>;

async function organization(call: Call, account: string, accountId: string): Promise<string> {
  try {
    return (await call<{ auth_domain: string }>("GET", `${account}/organizations`)).auth_domain;
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) permissionError(error);
  }
  // No Zero Trust organization yet: create one with a team name nobody else will have.
  try {
    const name = `unicorn-${accountId.slice(0, 8)}`;
    return (await call<{ auth_domain: string }>("POST", `${account}/organizations`, { name, auth_domain: `${name}.cloudflareaccess.com` })).auth_domain;
  } catch (error) {
    throw new AccessSetupError(
      `Cloudflare Zero Trust isn't turned on for this account yet (${errorText(error)}). Open one.dash.cloudflare.com once, pick a team name and the free plan, then try again.`,
    );
  }
}

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

function permissionError(error: unknown): never {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403)) {
    throw new AccessSetupError("That token is missing an Access permission. Make it from the link so all three permissions are filled in.");
  }
  throw new AccessSetupError(`Cloudflare said: ${errorText(error)}`);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
