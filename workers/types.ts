// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

export interface Env extends Cloudflare.Env {
	POLICY_AUD: string;
	TEAM_DOMAIN: string;

	// Outbound email via Mailgun (see workers/email-sender.ts). MAILGUN_API_KEY is a secret (not in
	// wrangler.jsonc vars, so not in the generated Cloudflare.Env — declare it here). MAILGUN_DOMAIN /
	// MAILGUN_API_BASE ARE vars, so `wrangler types` generates them (as literals) — do NOT redeclare them
	// here or the literal-vs-string widening breaks `extends Cloudflare.Env`.
	MAILGUN_API_KEY: string; // secret
	MAILGUN_SIGNING_KEY: string; // secret — Mailgun HTTP webhook signing key, verifies inbound Route POSTs
	ARTICLE_URL?: string; // public "how we run CPQ3D with AI" link; footer omits line until set
}
