import { afterEach, describe, expect, it, vi } from "vitest";
import { createRadiusOAuth } from "../src/auth/oauth/radius.ts";

const oauthConfig = {
	issuer: "https://auth.example.com",
	authorizationEndpoint: "https://auth.example.com/authorize",
	tokenEndpoint: "https://auth.example.com/token",
	deviceAuthorizationEndpoint: "https://auth.example.com/device",
	deviceAuthorizationEventsEndpoint: "https://auth.example.com/device/events",
	verificationEndpoint: "https://auth.example.com/verify",
	clientId: "pi",
	scope: "openid offline_access",
	deviceCodeGrantType: "urn:ietf:params:oauth:grant-type:device_code",
};

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("Radius OAuth", () => {
	it.each([
		["missing access token", { refresh_token: "refresh", expires_in: 3600 }],
		["empty refresh token", { access_token: "access", refresh_token: "", expires_in: 3600 }],
		["non-numeric expiry", { access_token: "access", refresh_token: "refresh", expires_in: "3600" }],
		["non-positive expiry", { access_token: "access", refresh_token: "refresh", expires_in: 0 }],
	] as const)("rejects a token response with %s", async (_label, tokenResponse) => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = input.toString();
				if (url === "https://radius.example.com/v1/oauth") {
					return Response.json(oauthConfig);
				}
				if (url === oauthConfig.tokenEndpoint) {
					return Response.json(tokenResponse);
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);
		const provider = createRadiusOAuth({
			name: "Radius",
			gateway: "https://radius.example.com",
		});

		await expect(
			provider.refresh(
				{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() },
				undefined,
			),
		).rejects.toThrow("Radius OAuth token response is missing or has invalid required fields");
	});

	it("retains the previous refresh token when the refresh response does not rotate it", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL) => {
				const url = input.toString();
				if (url === "https://radius.example.com/v1/oauth") {
					return Response.json(oauthConfig);
				}
				if (url === oauthConfig.tokenEndpoint) {
					return Response.json({ access_token: "new-access", expires_in: 3600 });
				}
				throw new Error(`Unexpected URL: ${url}`);
			}),
		);
		const provider = createRadiusOAuth({
			name: "Radius",
			gateway: "https://radius.example.com",
		});

		const credentials = await provider.refresh(
			{ type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() },
			undefined,
		);

		expect(credentials).toMatchObject({ access: "new-access", refresh: "old-refresh" });
	});
});
