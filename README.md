# pi-provider-kiro

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to the **Kiro API** (AWS CodeWhisperer/Q), exposing **12 kiro-cli-verified models** through one provider surface.

## Differences from upstream

This repository is a fork of [mikeyobrien/pi-provider-kiro](https://github.com/mikeyobrien/pi-provider-kiro). The main difference is **credential ownership and refresh behavior**.

| | Upstream | This fork |
|---|---|---|
| Preferred existing-credential source | `kiro-cli` | **Kiro IDE / KAM first**, `kiro-cli` only as fallback |
| KAM-injected IDE credentials | Not the primary path | Explicitly supported |
| IDE credential types | Limited / secondary use | Supports both `social` and `IdC` cache formats |
| Credential owner after import | May continue consulting `kiro-cli` | **Pi's `~/.pi/agent/auth.json` is authoritative** |
| Token refresh | Can depend on `kiro-cli` state | **Pi refreshes and persists rotated tokens itself** |
| Runtime 403 recovery | May re-read / refresh `kiro-cli` credentials | Refreshes the Pi-owned credential; does not substitute IDE/CLI state |
| Runtime dependency on KAM / Kiro IDE / kiro-cli | Can remain relevant | **None after a successful bootstrap** |

The purpose of this fork is to make long-running Pi sessions independent from `kiro-cli` token expiry or KAM-to-CLI synchronization. KAM/Kiro IDE is used only to bootstrap or intentionally switch accounts; after that, Pi owns the refresh-token lifecycle.

Other provider behavior is intentionally kept close to upstream unless noted here.

## Why this exists

Kiro gives you a strong free model menu, but pi needs a provider that speaks Kiro's auth, model catalog, and streaming protocol cleanly. `pi-provider-kiro` handles that bridge, including:

- AWS Builder ID, IAM Identity Center, Google, GitHub, and enterprise external IdP (OIDC) login flows
- IDE-first credential bootstrap (including credentials injected by Kiro Account Manager), with `kiro-cli` only as a fallback importer
- reasoning-aware streaming
- region-aware model filtering so pi only shows models your Kiro region can actually use

## Quick start

> **Important:** `pi install npm:pi-provider-kiro` installs the upstream npm package, not this fork.

To use this fork, clone it and install the local repository:

```bash
git clone https://github.com/NOHNOLIFE/pi-provider-kiro.git
cd pi-provider-kiro
npm install
npm run build
pi install .
```

Then log in from Pi:

```text
/login kiro
```

For the workflow this fork is designed for:

1. Use Kiro Account Manager (KAM) to switch/inject the desired account into **Kiro IDE**.
2. In Pi, run `/login kiro`.
3. Choose **Use existing credentials**.
4. The provider imports the IDE credential into Pi.
5. From then on, Pi refreshes and persists the credential itself. KAM, Kiro IDE, and `kiro-cli` are no longer part of the runtime refresh path.

The bootstrap order is:

1. Kiro IDE cache: `~/.aws/sso/cache/kiro-auth-token.json`
2. `kiro-cli` social credential, if available
3. Other `kiro-cli` credentials
4. Interactive OAuth login

Kiro IDE / KAM credentials are normalized as follows:

- `authMethod: "social"` (Google/GitHub) → Kiro desktop refresh flow
- `authMethod: "IdC"` (Builder ID / IAM Identity Center) → AWS OIDC refresh flow using the companion `{clientIdHash}.json`

After import, **Pi's `~/.pi/agent/auth.json` is authoritative**. Refresh-token rotation and runtime `403` recovery use the Pi-owned credential instead of re-reading or refreshing KAM/IDE/`kiro-cli` state.

Because refresh tokens may rotate, avoid actively refreshing the same account in KAM/Kiro IDE while Pi is using the imported credential. Use KAM/IDE again when you intentionally want to bootstrap or switch Pi to another account.

Interactive login is still available for the login methods supported by upstream.

## Models

| Family | Models | Context | Reasoning |
|--------|--------|---------|-----------|
| Claude Opus | `claude-opus-4-7`, `claude-opus-4-6` | 1M | ✓ |
| Claude Sonnet 4.6 | `claude-sonnet-4-6` | 1M | ✓ |
| Claude Sonnet 4.5 | `claude-sonnet-4-5` | 200K | ✓ |
| Claude Sonnet 4 | `claude-sonnet-4` | 200K | ✓ |
| Claude Haiku 4.5 | `claude-haiku-4-5` | 200K | ✗ |
| DeepSeek 3.2 | `deepseek-3-2` | 164K | ✓ |
| MiniMax | `minimax-m2-1`, `minimax-m2-5` | 196K | ✗ |
| GLM 5 | `glm-5` | 200K | ✓ |
| Qwen3 Coder | `qwen3-coder-next` | 256K | ✓ |
| Auto | `auto` | 1M | ✓ |

All listed models are free to use through Kiro.

## Usage

Once logged in, select any Kiro model in pi:

```text
/model claude-sonnet-4-6
```

Or let Kiro pick automatically:

```text
/model auto
```

Reasoning is automatically enabled for supported models. Use `/reasoning` to adjust the thinking budget.

### Estimated usage

Kiro reports an exact credit count for completed turns, but not a per-turn USD charge. It also currently omits the cache-read and cache-write fields modeled by its token-usage response. Both estimates are independently opt-in:

```json
{
  "pi-provider-kiro": {
    "usageTracking": {
      "estimateDollarValue": true,
      "estimateCacheUsage": true,
      "estimatedCacheTimeout": 300000
    }
  }
}
```

`estimateDollarValue` converts credits to an estimated USD-equivalent value for Pi usage dashboards. `usdPerCredit` defaults to Kiro's published add-on rate of `$0.04` per credit and may be overridden. The legacy `enabled: true` setting remains accepted as a deprecated alias for `estimateDollarValue: true`.

`estimateCacheUsage` conservatively reclassifies prompt tokens repeated from the previous successful turn in the same session as `cacheRead`. The first turn, large context reductions, idle gaps beyond `estimatedCacheTimeout`, and any response carrying real wire cache counters remain untouched. The timeout defaults to five minutes; set it to `0` to disable expiry. Estimated messages include `usage.cacheEstimated: true` so audits can distinguish estimates from provider-reported values.

These values are estimates, not wire truth, invoices, or confirmed marginal charges. Credits included in a subscription may have no marginal cost, and estimated cache usage does not prove that Kiro served a backend cache hit. Tracking is disabled by default, and invalid settings fail closed for the affected estimate. Pi's HTML session export currently recomputes component costs and may therefore show `$0`; cost dashboards and summaries that read `usage.cost.total` show the dollar-value estimate.

### Usage in the footer

Opt in to a compact allowance indicator in Pi's footer while a Kiro model is active:

```json
{
  "pi-provider-kiro": {
    "showUsageInFooter": true
  }
}
```

The badge shows the percent of your allowance **used** (e.g. `◆ Kiro 1%`), colored by consumption — comfortable below 70%, warning at 70%, and critical at 90%. It refreshes on session start, model switches, and after completed Kiro turns, throttled to avoid extra requests. It stays hidden for non-Kiro models, when no local Kiro credential is available, or if a usage lookup fails, and is disabled by default.

## Retry Behavior

Generic transient retries such as HTTP `429` and `5xx` are handled by `pi-coding-agent` at the session layer.

This provider only keeps local recovery for Kiro-specific cases:
- `403` auth races, where it refreshes Pi's persisted Kiro credential without consulting IDE/kiro-cli
- first-token / stalled-stream recovery
- empty-stream retries
- non-retryable Kiro body markers like `MONTHLY_REQUEST_COUNT` and `INSUFFICIENT_MODEL_CAPACITY`

The reason codes this provider classifies on are published from the package
entry point, so consumers can interpret a code without hardcoding their own copy
of the literals:

```ts
import {
  KIRO_REASON_CODES,
  isCapacityError,
  isNonRetryableBodyError,
  isTooBigError,
} from "pi-provider-kiro";

isTooBigError(400, body); // size rejection → safe to compact and retry
isCapacityError(body); // transient capacity → safe to retry as-is
isNonRetryableBodyError(body); // hard quota → do not retry
```

These are Kiro's own codes, not a provider taxonomy: mapping them to your own
semantics is the consumer's job.

One caveat for consumers outside pi: the entry point is the whole provider, so
importing it loads modules that import pi's host packages
(`@earendil-works/pi-ai`, `-pi-coding-agent`, `-pi-tui`). They are declared as
optional peer dependencies — present already wherever this runs as a pi
extension, but a standalone project must install them itself or the import fails
with `ERR_MODULE_NOT_FOUND`. The types resolve without them under the usual
`skipLibCheck`.

## Development

```bash
npm run build       # Compile TypeScript
npm run check       # Type check (no emit)
npm test            # Run the Vitest suite
npm run test:watch  # Watch mode
```

## Architecture

The extension is organized as one feature per file:

```
src/
├── index.ts            # Extension registration
├── models.ts           # 12 model definitions + ID resolution
├── oauth.ts            # Multi-provider auth (Builder ID / Google / GitHub)
├── kiro-cli.ts         # kiro-cli bootstrap compatibility / fallback import
├── transform.ts        # Message format conversion
├── history.ts          # Conversation history management
├── thinking-parser.ts  # Streaming <thinking> tag parser
├── token-type.ts       # `tokentype` header for external IdP bearer tokens
├── event-parser.ts     # Kiro stream event parser
└── stream.ts           # Main streaming orchestrator
```

See [AGENTS.md](AGENTS.md) for detailed development guidance and [.agents/summary/](/.agents/summary/index.md) for full architecture documentation.

## License

MIT
