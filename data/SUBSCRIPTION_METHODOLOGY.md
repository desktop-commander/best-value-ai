# Subscription Value Methodology

Because AI providers (OpenAI, Anthropic, Google) do not publish exact daily token budgets for their "unlimited" or "message-capped" plans, this project uses an empirical estimation model.

## 1. The "Turn" Standard (6,400 Tokens)
We standardize a single "message" or "turn" at **6,400 tokens**.

*   **Source:** [OpenRouter 2025 State of AI Report](https://a16z.com/state-of-ai/)
*   **Why:** Based on a study of 100 trillion real-world tokens, the average prompt length has quadrupled to ~6,000 tokens while completions average ~400 tokens. This reflects modern "context-heavy" usage like coding and long-document analysis.

## 2. Capacity Scaling (The 10x Rule)
We use a **10x capacity multiplier** to estimate "Unlimited" or "Pro" tiers compared to "Plus" tiers.

*   **Logic:** OpenAI provides exactly 10x capacity for high-compute features in the Pro tier ($200) compared to Plus ($20).
*   **Proof:** Plus users get **25** Deep Research queries/mo, while Pro users get **250** queries/mo.
*   **Scaling:** 
    *   **Plus Limit:** 1,280 msgs/day (based on 160 msgs/3hr caps)
    *   **Pro Limit:** 12,800 msgs/day (10x scaling)

## 3. Provider Specific Logic

### ChatGPT Plus ($20)
*   **Daily Tokens:** 8,192,000
*   **Formula:** 160 msgs / 3hr × 8 windows × 6,400 tokens per turn.

### ChatGPT Pro ($200)
*   **Daily Tokens:** 81,920,000
*   **Formula:** Plus Daily Tokens × 10 (Linear scaling based on verified Deep Research parity).

### Claude Pro ($20) / Gemini Advanced ($20)
*   **Daily Tokens:** 640,000
*   **Formula:** 100 msgs / day × 6,400 tokens per turn.
*   **Note:** These providers have more aggressive "dynamic" limits that decrease as conversation history grows.

---
*Last Updated: January 25, 2026*
