import type { Step, Job } from "./payOnProof.js";

/** The AI parts of the demo: the seller's actual work (a summary) and a one-line
 * explanation of each money decision for the owner. Neither can move money: the
 * gates in payOnProof.ts decide. Gemini if GEMINI_API_KEY, else Claude if
 * ANTHROPIC_API_KEY, else plain-text fallbacks so the demo still runs. */

const GEMINI = process.env.GEMINI_API_KEY;
const ANTHROPIC = process.env.ANTHROPIC_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL ?? "gemini-2.5-flash";
const CLAUDE_MODEL = process.env.CLAUDE_MODEL ?? "claude-haiku-4-5";

export const aiName = () => (GEMINI ? GEMINI_MODEL : ANTHROPIC ? CLAUDE_MODEL : "none (fallback text)");

async function ask(prompt: string, maxTokens = 300): Promise<string | null> {
  if (GEMINI) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return j.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("").trim() || null;
  }
  if (ANTHROPIC) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": ANTHROPIC, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return j.content?.map((c: any) => c.text ?? "").join("").trim() || null;
  }
  return null;
}

/** Seller's work. */
export async function summarize(request: string): Promise<string> {
  return (
    (await ask(`${request}\nAnswer in at most 3 short sentences, plain text.`).catch(() => null)) ??
    "An agent that pays before delivery can be paid for nothing. Holding the payment until a signed receipt matches what was delivered means a bad delivery costs the payer nothing. The receipt then becomes portable proof of the seller's track record."
  );
}

const FALLBACK: Record<Step["kind"], (s: any) => string> = {
  trust: (s) => (s.decision === "deny" ? "This seller has no INAM record, so there is nothing to trust yet." : `The seller checks out (${s.decision}); payment will still wait for proof.`),
  refused: () => "Refused before any payment call: no money was requested or held.",
  hold_created: (s) => (s.rail === "x402" ? "The buyer signed a USDC payment and kept it; nothing is sent until the work checks out." : "PayPal order created. The owner approves once; the money is held, not moved."),
  held: (s) => `${s.amount} ${s.currency} is on hold. The seller can see the money exists but cannot take it.`,
  delivered: () => "Work delivered. Comparing what arrived with what the seller's receipt claims.",
  verified: () => "The receipt matches the delivery, so the buyer countersigned it.",
  captured: () => "Captured: the seller is paid against a verified receipt.",
  rejected: (s) => `Refused to countersign (${s.code}): the receipt does not match what was delivered or held.`,
  voided: () => "Hold released. The payer was never charged.",
};

/** One sentence for the owner about a step. */
export async function explain(s: Step, job: Job): Promise<string> {
  const facts = JSON.stringify(s);
  const ai = await ask(
    `You explain a payment agent's decisions to a small-business owner in ONE short sentence (max 25 words), no jargon, no hype. ` +
      `Job: ${job.capability} for ${job.amount} ${job.currency}. Event: ${facts}. Do not invent facts beyond the event.`,
    80,
  ).catch(() => null);
  return ai ?? FALLBACK[s.kind](s);
}
