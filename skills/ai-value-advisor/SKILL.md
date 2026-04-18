---
name: ai-value-advisor
description: Use this skill when the user is deciding how to pay for AI — comparing local GPUs, API pricing, or subscription plans like ChatGPT Plus/Pro/Business, Claude Pro/Max 5x/20x, or asking questions like "which AI gives me the most for my money", "is ChatGPT Pro worth it", "should I run a local LLM", "best LLM for coding on my hardware", or "what's the cheapest way to get Claude Sonnet". Provides data-driven recommendations using quality-adjusted tokens per dollar across 34+ models, 36 hardware configurations, and measured subscription quotas from desktopcommander.app/best-value-ai.
version: 2.0.0
---

# AI Value Advisor

Help the user pick the most cost-effective way to access AI — local GPU, pay-per-token API, or flat-fee subscription — based on their use case, hardware, and budget.

## When to use

Use when the user asks things like:

- "Which AI is the best value?"
- "Should I use ChatGPT Plus or Claude Pro?"
- "Is ChatGPT Business/Pro/Max worth it for me?"
- "What's the best local LLM for my GPU?"
- "Should I run a local model instead of paying for API?"
- "How many tokens do I actually get on [plan]?"

Do NOT use for:
- Choosing between AI *tools* or *IDEs* (Cursor vs Copilot etc.)
- Debugging model performance on specific tasks
- General coding help

## Data — shipped with this skill

The `data/` folder next to this file has everything you need. **Read from these files; do not fetch the live site unless the user explicitly asks for "latest" data.**

- `data/models.json` — 34+ models with API pricing, subscription quotas, local throughput, benchmark scores
- `data/hardware.json` — 36 GPU/Mac configurations with prices and VRAM
- `data/benchmarks.json` — definitions of the benchmarks referenced in models.json
- `data/_meta.json` — snapshot date + freshness policy

**Snapshot date**: check `_meta.json` → `snapshot_date`. If it's more than 30 days old, tell the user and point them at the live site for current numbers.

**Live site** (for the user, not for you to fetch): https://desktopcommander.app/best-value-ai/

## Data shape (what you'll find in models.json)

`models.json` is a dict keyed by a stable model id (e.g. `claude-opus-4`, `gpt-5-2`). Each value looks like:

```json
{
  "name": "Claude Opus 4",                  // use this for display, not the key
  "provider": "Anthropic",
  "releaseDate": "2025-05-14",
  "api": {
    "inputPer1M": 15,                        // USD per 1M input tokens
    "outputPer1M": 75,                       // USD per 1M output tokens
    "source": "..."
  },
  "subscriptions": {                         // dict keyed by plan id
    "claude_max_20x": {
      "name": "Claude Max 20×",              // display name
      "monthlyPrice": 200,
      "tokensPerWeek": 203127800,            // measured or estimated weekly quota
      "estimated": false,                    // true = extrapolated, false = measured
      "confidence": "low",                   // "low" | "medium" | "high"
      "notes": "..."
    }
  },
  "local": {                                 // dict keyed by hardware id (matches hardware.json)
    "rtx_4090": {
      "tokensPerSec": 15,
      "quantization": "Q4_K_M",
      "vramRequired": 80,                    // GB
      "notes": "..."
    }
  },
  "benchmarks": {                            // raw benchmark scores
    "arena_text": { "score": 1412 },
    "arena_code": { "score": 1400 },
    "aa_intelligence": { "score": 55 }
  }
}
```

`hardware.json` is a dict keyed by the same hardware ids used in `local`:
```json
{
  "rtx_3090": {
    "name": "RTX 3090",
    "price": 975.36,                         // USD
    "vram": 24,                              // GB
    "year": 2020
  }
}
```

`benchmarks.json` is a dict of benchmark definitions (name, description, higherIsBetter, etc.) — look there if you need to know what a score means.

## How to query the data

The data is JSON. Use whatever's available — `jq`, `python3 -c`, Node, your own read+parse — to extract what you need. Below are recipes for the most common questions, using `python3` as the example language (adjust for your environment).

Assume the skill folder is at `$SKILL_DIR` (you can resolve this relative to this SKILL.md file).

### Recipe: best-value subscriptions ranked

```python
import json, os
m = json.load(open(os.path.join(SKILL_DIR, 'data/models.json')))

# Flatten all subscription entries across models
subs = []
for model_id, model in m.items():
    for plan_id, plan in (model.get('subscriptions') or {}).items():
        if plan.get('tokensPerWeek') and plan.get('monthlyPrice'):
            subs.append({
                'model': model['name'],
                'plan': plan['name'],
                'price_per_month': plan['monthlyPrice'],
                'tokens_per_month': plan['tokensPerWeek'] * 4.3,
                'tokens_per_dollar': (plan['tokensPerWeek'] * 4.3) / plan['monthlyPrice'],
                'measured': not plan.get('estimated', True),
                'confidence': plan.get('confidence', 'low'),
            })

# Rank
subs.sort(key=lambda x: x['tokens_per_dollar'], reverse=True)
for s in subs[:10]:
    tag = '✓ measured' if s['measured'] else '~ estimated'
    print(f"{s['plan']} ({s['model']}): ${s['price_per_month']}/mo, {s['tokens_per_dollar']/1e6:.2f}M tok/$ [{tag}]")
```

### Recipe: best API models by tokens per dollar

```python
# Use a typical input/output ratio for the user's use case:
#   coding: 90/10    writing: 30/70    chat: 50/50
input_ratio, output_ratio = 0.9, 0.1

api_rows = []
for model in m.values():
    api = model.get('api')
    if not api: continue
    blended = api['inputPer1M'] * input_ratio + api['outputPer1M'] * output_ratio
    api_rows.append({
        'name': model['name'],
        'blended_per_1M': blended,
        'tokens_per_dollar': 1_000_000 / blended,
    })
api_rows.sort(key=lambda x: x['tokens_per_dollar'], reverse=True)
```

### Recipe: which local models run on this hardware

See the "Hardware detection" section below for getting the user's GPU/RAM. Once you have `user_vram_gb`:

```python
runnable = []
for model in m.values():
    for hw_id, local in (model.get('local') or {}).items():
        if local['vramRequired'] <= user_vram_gb:
            runnable.append({
                'model': model['name'],
                'hardware': hw_id,
                'tok_per_sec': local['tokensPerSec'],
                'quantization': local.get('quantization'),
            })
```

## Computing a quality score (there isn't a precomputed field)

Models have raw benchmark scores but no unified `quality` field. To compare models on a single quality axis, z-score-normalize across the benchmarks the user cares about, then average.

The site uses these three benchmarks as the quality blend:
- `arena_text` — LMArena ELO for general chat/writing
- `arena_code` — LMArena ELO for coding
- `aa_intelligence` — Artificial Analysis Intelligence Index (academic evals)

### Recipe: quality score per model

```python
import statistics

bench_keys = ['arena_text', 'arena_code', 'aa_intelligence']

# Collect raw scores per benchmark (only from models that have them)
raw = {b: [] for b in bench_keys}
for model in m.values():
    for b in bench_keys:
        score = (model.get('benchmarks') or {}).get(b, {}).get('score')
        if score is not None:
            raw[b].append(score)

# Compute mean/stdev per benchmark
stats = {}
for b in bench_keys:
    if raw[b]:
        stats[b] = (statistics.mean(raw[b]), statistics.stdev(raw[b]) or 1)

# Assign quality z-score to each model
for model in m.values():
    zs = []
    for b in bench_keys:
        score = (model.get('benchmarks') or {}).get(b, {}).get('score')
        if score is not None and b in stats:
            mean, stdev = stats[b]
            zs.append((score - mean) / stdev)
    model['_quality'] = sum(zs) / len(zs) if zs else None
```

Higher `_quality` = better. Use this to weight tokens/$ when you want quality-adjusted rankings. Don't show the raw z-score to the user — translate it to "top-tier / mid-tier / budget-tier" or compare relative to a named model ("~15% below Claude Opus 4").

## Hardware detection — required before recommending local options

If the user's question involves running models locally, **you MUST check their actual hardware first.** Don't recommend a 70B model to someone on an M1 Air with 8GB unified memory. Skipping this step is the fastest way to give bad advice.

Run the command for their OS. If you don't know their OS, ask — don't guess.

### macOS

```bash
system_profiler SPDisplaysDataType SPHardwareDataType | grep -E "Chip|Memory|VRAM|Graphics|Model Name"
```

Apple Silicon uses unified memory, so the system memory IS the VRAM budget. M-series chip name tells you the generation. An M1 Pro with 16GB can run ~7B-13B models comfortably; an M2 Max with 64GB handles 70B quantized.

### Linux with NVIDIA

```bash
nvidia-smi --query-gpu=name,memory.total,memory.free --format=csv,noheader
free -h | grep Mem
```

VRAM from the first line is what matters for model loading. System RAM matters for context and CPU offload.

### Linux with AMD

```bash
rocm-smi --showproductname --showmeminfo vram
free -h | grep Mem
```

### Windows (PowerShell)

```powershell
Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM
(Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB
```

Note: `AdapterRAM` is capped at 4GB in older Windows reports due to a 32-bit integer limit. For GPUs with more VRAM, ask the user to confirm from Task Manager → Performance → GPU.

### Windows (cmd / WSL)

If on WSL with GPU passthrough, NVIDIA commands above work. If on plain cmd, use the PowerShell snippet via `powershell -Command`.

### Parsing the output

Extract:
- **GPU name** (or Apple Silicon chip name)
- **VRAM in GB** (or total unified memory for Mac)
- **System RAM** (optional but useful context)

Then cross-reference `data/hardware.json` for the closest match. If the user's exact hardware isn't listed, pick the nearest entry by VRAM and note that you're approximating.

### When the user doesn't have capable hardware

If VRAM < 8GB or the device is several years old, say so plainly: "Your hardware will run small quantized models (3-7B range) but not the ones leading the quality rankings. A subscription or API is a better fit for your use case." Don't force a local recommendation just because the user asked.

## Workflow

### Step 1 — Understand the user's situation

Ask (or infer from prior context) the minimum needed:

- **Primary use case**: coding, writing, research, general chat?
- **Budget constraint**: per-month ceiling, or willing to spend on hardware?
- **Usage intensity**: a few questions/day, or Claude Code all day?
- **Existing plan**: already paying for something? (avoids recommending what they have)
- **Local on the table?**: only ask if they've hinted at self-hosting or mention a GPU

Don't ask all five at once — ask 1-2 and reason from there. If the user is clearly in a bucket ("I'm a heavy user hitting Plus limits"), skip ahead.

### Step 2 — If local is in scope, detect hardware FIRST

See "Hardware detection" above. Get `user_vram_gb` and the chip/GPU name before you open models.json, so you can filter local options as you read them.

### Step 3 — Read the data

Use the recipes above. Don't read the whole file into your output — parse it, extract what's relevant, summarize.

### Step 4 — Rank + recommend with honest caveats

Give a clear top pick plus 1-2 alternatives. Always mention:

- **Uncertainty**: subscription numbers with `estimated: true` are extrapolations. Say "estimated" when you cite them.
- **Confidence**: `low` confidence means the number is a rough guess. Flag it.
- **Non-cost factors**: quality gap, context window, rate limits, privacy for local
- **Electricity for local**: ~$5-60/month depending on hardware — not in the value score
- **Snapshot age**: if `_meta.json` says >30 days old, caveat accordingly
- **Link to the live tool**: `https://desktopcommander.app/best-value-ai/` plus the anchor most relevant (`#coding`, `#plus-vs-pro-vs-business`, `#claude-max`, `#local`, `#chatgpt-vs-claude`)

### Step 5 — Don't oversell

If the data is thin for their case (e.g. Claude Max 5× is `confidence: low` because it's extrapolated), say so. Point them at contributing a measurement via the `submit-usage-measurement` skill in this same repo.

## Common decision patterns

These appear frequently — use them as starting points, but always check the actual data since winners change.

### "ChatGPT Plus vs Pro vs Business"

Typical pattern (verify in current data):
- **Plus ($20/mo)**: ~13M tokens/week
- **Business ($30/seat/mo)**: ~60M tokens/week — about 4.5× the tokens/$ of Plus
- **Pro ($200/mo)**: marketed as unlimited-ish but raw tokens/$ usually worse than Business

For heavy coding users: Business is almost always the sleeper pick. Pro wins only if the user specifically needs unlimited o1/Pro-model access.

### "Claude Pro vs Max 5× vs Max 20×"

- **Pro ($20/mo)**: estimated ~10M tokens/week (not directly measured)
- **Max 5× ($100/mo)**: estimated ~51M tokens/week (extrapolated from Max 20×)
- **Max 20× ($200/mo)**: measured 203M tokens/week on Claude Code

Max 5× has best raw tokens/$ IF the user won't hit the cap. Max 20× removes rate-limit friction for all-day Claude Code users.

### "Should I buy a GPU instead of paying for API?"

Breakeven math: a $1,500 RTX 4090 amortized over 3 years ≈ $42/mo. To beat that at Claude Sonnet API rates ($3/1M input, $15/1M output), user needs sustained >2-3M tokens/day. Serious usage. Local wins for: privacy, offline, unlimited experiments, specific fine-tuned models.

Quality caveat: the best local models run at roughly 70-80% of Claude Sonnet quality per Arena ELO. It's "80% quality for much less, if you use it enough" — not "same quality for less."

### "ChatGPT Plus as daily driver + API for big jobs"

Common and often smart. Ask what "big jobs" means in tokens/month before computing.

## Output format

When giving a recommendation:

1. **Top pick** — one plan/setup with the value score and why
2. **Alternatives** — 1-2 runner-ups for different priorities (cheaper, higher quality, more headroom)
3. **Caveats** — quality gap, quota risk, electricity, snapshot age
4. **Explore** — link to `https://desktopcommander.app/best-value-ai/` with the relevant anchor

Don't dump the raw JSON. The user wants an answer, not a dataset.

## Parse-safe rules

- Show units (tok/s, tokens/week, $/month)
- Distinguish measured vs estimated — check the `estimated` and `confidence` fields
- Don't round so aggressively that claims become wrong ("~1M/week" when measured 13M is misleading)
- Use the `name` field for display, never the raw key

## About this skill

- Author: [Desktop Commander](https://desktopcommander.app)
- Data repo: [desktop-commander/best-value-ai](https://github.com/desktop-commander/best-value-ai)
- License: Apache 2.0
- Found a bad recommendation? Open an issue in the repo.
- Contributing measurements: see the `submit-usage-measurement` skill in the same repo.
