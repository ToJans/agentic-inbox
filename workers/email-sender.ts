// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Outbound email via Mailgun's HTTP API.
 *
 * Replaces the Cloudflare `send_email` binding (env.EMAIL.send()), which only
 * delivers to addresses verified in the account — fine for self-notifications,
 * not for arbitrary customer/manufacturer recipients. Mailgun is a real MTA
 * with SPF/DKIM on the sending subdomain, so it reaches strangers' inboxes.
 *
 * Two CPQ3D-specific behaviours are folded in here because this is the single
 * chokepoint every send path (UI compose, reply, forward, agent tools) flows
 * through:
 *   1. AI-disclosure footer — appended to every outbound body (non-negotiable;
 *      see docs/org/ai-disclosure.md in the apollo repo).
 *   2. Honest default — the footer defaults to the "autonomous" variant. Callers
 *      may opt into a stronger claim (reviewed / written-with-Tom) only when true.
 *
 * Config (env):
 *   MAILGUN_API_KEY   (secret)  - Mailgun private API key
 *   MAILGUN_DOMAIN    (var)     - sending domain, e.g. "ai.cpq3d.com"
 *   MAILGUN_API_BASE  (var?)    - "https://api.mailgun.net" (US) or
 *                                 "https://api.eu.mailgun.net" (EU). Default US.
 *   ARTICLE_URL       (var?)    - public "how we run CPQ3D with AI" link.
 *                                 Footer omits the link line until this is set.
 */

import type { Env } from "./types";

export type DisclosureVariant = "autonomous" | "reviewed" | "with-tom";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
	/** Honesty level of the disclosure footer. Defaults to "autonomous". */
	disclosure?: DisclosureVariant;
}

/**
 * Send an email through Mailgun.
 *
 * @param env     - Worker env (Mailgun creds + disclosure config)
 * @param params  - Email parameters (to, from, subject, body, etc.)
 * @returns       - { messageId } from Mailgun
 * @throws        - On config or delivery errors
 */
export async function sendEmail(
	env: Env,
	params: SendEmailParams,
): Promise<{ messageId: string }> {
	const apiKey = env.MAILGUN_API_KEY;
	const domain = env.MAILGUN_DOMAIN;
	if (!apiKey || !domain) {
		throw new Error("Mailgun is not configured (MAILGUN_API_KEY / MAILGUN_DOMAIN)");
	}
	const base = env.MAILGUN_API_BASE || "https://api.mailgun.net";

	// Append the AI-disclosure footer to whichever bodies are present.
	const role = roleFromAddress(params.from);
	const footer = buildFooter(params.disclosure ?? "autonomous", role, env.ARTICLE_URL);
	const html = params.html ? `${params.html}${footer.html}` : undefined;
	const text = params.text ? `${params.text}${footer.text}` : undefined;
	// If only HTML was supplied the footer still lands; if neither body exists,
	// send the footer as text so disclosure is never silently dropped.
	const finalText = text ?? (html ? undefined : footer.text.trimStart());

	const form = new FormData();
	form.append("from", formatAddress(params.from));
	for (const addr of toArray(params.to)) form.append("to", addr);
	for (const addr of toArray(params.cc)) form.append("cc", addr);
	for (const addr of toArray(params.bcc)) form.append("bcc", addr);
	form.append("subject", params.subject);
	if (html) form.append("html", html);
	if (finalText) form.append("text", finalText);
	if (params.replyTo) form.append("h:Reply-To", formatAddress(params.replyTo));

	// Custom + threading headers (In-Reply-To, References, …) → Mailgun "h:" prefix.
	for (const [key, value] of Object.entries(params.headers ?? {})) {
		form.append(`h:${key}`, value);
	}

	for (const att of params.attachments ?? []) {
		const blob = new Blob([base64ToBytes(att.content)], { type: att.type });
		if (att.disposition === "inline") {
			// Mailgun references inline parts by their filename as the cid.
			form.append("inline", blob, att.contentId || att.filename);
		} else {
			form.append("attachment", blob, att.filename);
		}
	}

	const res = await fetch(`${base}/v3/${domain}/messages`, {
		method: "POST",
		headers: { Authorization: `Basic ${btoa(`api:${apiKey}`)}` },
		body: form,
	});

	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(`Mailgun send failed (${res.status}): ${detail.slice(0, 300)}`);
	}

	const result = (await res.json()) as { id?: string };
	return { messageId: (result.id ?? "").replace(/^<|>$/g, "") };
}

// ── helpers ────────────────────────────────────────────────────────

function toArray(v?: string | string[]): string[] {
	if (!v) return [];
	return Array.isArray(v) ? v : [v];
}

function formatAddress(addr: string | { email: string; name: string }): string {
	return typeof addr === "string" ? addr : `${addr.name} <${addr.email}>`;
}

/** "cro@ai.cpq3d.com" → "CRO"; falls back to a capitalised local-part. */
function roleFromAddress(from: string | { email: string; name: string }): string {
	const email = typeof from === "string" ? from : from.email;
	const local = (email.split("@")[0] || "").split(/[.+]/)[0];
	if (!local) return "agent";
	return local.length <= 4 ? local.toUpperCase() : local.charAt(0).toUpperCase() + local.slice(1);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
	const binary = atob(b64);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

/**
 * Build the AI-disclosure footer (html + text) for a given honesty variant.
 * Mirrors the canonical copy in docs/org/ai-disclosure.md.
 */
function buildFooter(
	variant: DisclosureVariant,
	role: string,
	articleUrl?: string,
): { html: string; text: string } {
	const lines: Record<DisclosureVariant, string> = {
		autonomous:
			`Sent autonomously by CPQ3D's AI ${role} agent on behalf of Tom Janssens (Core BV). ` +
			`This mailbox is operated by an AI agent; replies are read and handled by AI. ` +
			`Tom did not personally review this message.`,
		reviewed:
			`Drafted by CPQ3D's AI ${role} agent and reviewed by Tom Janssens before sending (Core BV). ` +
			`Replies to this address are handled by an AI agent.`,
		"with-tom":
			`Written by Tom Janssens with CPQ3D's AI ${role} agent (Core BV). ` +
			`Replies to this address are handled by an AI agent.`,
	};
	const body = lines[variant];
	const link = articleUrl ? ` How we run CPQ3D with AI: ${articleUrl}` : "";

	const text = `\n\n— ${body}${link}`;
	const html =
		`<br><br><div style="border-top:1px solid #e5e7eb;margin-top:16px;padding-top:8px;color:#6b7280;font-size:12px;line-height:1.5">` +
		`— ${escapeFooter(body)}` +
		(articleUrl
			? ` <a href="${escapeFooter(articleUrl)}" style="color:#6b7280">How we run CPQ3D with AI</a>`
			: "") +
		`</div>`;
	return { html, text };
}

function escapeFooter(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}
