# OpenAI prompt cache research

Verified against official OpenAI documentation on 2026-09-22. Prices are USD per 1 million tokens. This document distinguishes API billing from ChatGPT plan usage.

## Current API prices

OpenAI renamed Priority processing to Fast mode on 2026-07-30. API requests may still use either `service_tier: "priority"` or `service_tier: "fast"`. The following are the short-context rates from the current pricing page.

| Model | Standard input | Standard cache read | Standard cache write | Standard output | Fast or Priority input | Fast or Priority cache read | Fast or Priority cache write | Fast or Priority output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | $10.00 | $1.00 | $12.50 | $50.00 | $20.00 | $2.00 | $25.00 | $100.00 |
| `gpt-6-sol` | $2.00 | $0.20 | $2.50 | $10.00 | $4.00 | $0.40 | $5.00 | $20.00 |
| `gpt-6-luna` | $0.10 | $0.01 | $0.125 | $0.50 | $0.20 | $0.02 | $0.25 | $1.00 |
| `gpt-5.6-sol` | $4.00 | $0.40 | $5.00 | $20.00 | $8.00 | $0.80 | $10.00 | $40.00 |
| `gpt-5.6-terra` | $2.00 | $0.20 | $2.50 | $12.00 | $4.00 | $0.40 | $5.00 | $24.00 |
| `gpt-5.6-luna` | $0.20 | $0.02 | $0.25 | $1.20 | $0.40 | $0.04 | $0.50 | $2.40 |
| `gpt-5.5` below 272K context | $5.00 | $0.50 | no separate charge | $30.00 | $12.50 | $1.25 | no separate charge | $75.00 |

For GPT-5.6 and later, cache reads are 0.1 times uncached input and cache writes are 1.25 times uncached input. A write is an alternative input-token rate, not an additive fee.

### Long-context rates

The current threshold is more than 272K input tokens. The higher rates apply to the full request.

| Model | Standard input | Standard cache read | Standard cache write | Standard output | Fast or Priority input | Fast or Priority cache read | Fast or Priority cache write | Fast or Priority output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | $20.00 | $2.00 | $25.00 | $75.00 | $40.00 | $4.00 | $50.00 | $150.00 |
| `gpt-6-sol` | $4.00 | $0.40 | $5.00 | $15.00 | $8.00 | $0.80 | $10.00 | $30.00 |
| `gpt-6-luna` | $0.20 | $0.02 | $0.25 | $0.75 | $0.40 | $0.04 | $0.50 | $1.50 |
| `gpt-5.6-sol` | $8.00 | $0.80 | $10.00 | $30.00 | $16.00 | $1.60 | $20.00 | $60.00 |
| `gpt-5.6-terra` | $4.00 | $0.40 | $5.00 | $18.00 | $8.00 | $0.80 | $10.00 | $36.00 |
| `gpt-5.6-luna` | $0.40 | $0.04 | $0.50 | $1.80 | $0.80 | $0.08 | $1.00 | $3.60 |
| `gpt-5.5` | $10.00 | $1.00 | no separate charge | $45.00 | not published | not published | not published | not published |

The Fast table does not publish long-context GPT-5.5 rates. Do not derive or display them.

### GPT-6 Batch and Flex rates

The published Batch and Flex rates match each other at 50 percent of Standard. They are API processing tiers, not Codex local task modes. Each row gives input, cached input, cache write, and output prices per million tokens. The long band applies to the full request when input exceeds 272K tokens.

| Model | Short input | Short read | Short write | Short output | Long input | Long read | Long write | Long output |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| `gpt-6-astra` | $5.00 | $0.50 | $6.25 | $25.00 | $10.00 | $1.00 | $12.50 | $37.50 |
| `gpt-6-sol` | $1.00 | $0.10 | $1.25 | $5.00 | $2.00 | $0.20 | $2.50 | $7.50 |
| `gpt-6-luna` | $0.05 | $0.005 | $0.0625 | $0.25 | $0.10 | $0.01 | $0.125 | $0.375 |

The API Fast table is twice Standard for each GPT-6 token category. The `priority` request value is an alias for Fast, but actual response tier can differ if processing is downgraded. The response tier, rather than the requested tier, determines actual billing. CodexZero only has the requested local task tier and therefore shows an API equivalent estimate, not a bill.

Regional processing adds 10 percent to eligible GPT-6 API rates. For Astra, Sol, and Luna, EU data residency supports Standard processing only, not Batch, Flex, or Fast. Cache entries cannot be reused across regional processing boundaries. CodexZero does not observe the API processing region and does not add this uplift to its local estimate. Other charges, such as tools, are separate from model token prices.

### Older GPT-5 Codex models

| Model | Standard input | Standard cache read | Standard output | Fast or Priority |
| --- | ---: | ---: | ---: | --- |
| `gpt-5.3-codex` | $1.75 | $0.175 | $14.00 | $3.50 input, $0.35 read, $28.00 output |
| `gpt-5.2-codex` | $1.75 | $0.175 | $14.00 | not published on the current pricing page |
| `gpt-5.1-codex` | $1.25 | $0.125 | $10.00 | not published on the current pricing page |
| `gpt-5.1-codex-max` | $1.25 | $0.125 | $10.00 | not published on the current pricing page |
| `gpt-5.1-codex-mini` | $0.25 | $0.025 | $2.00 | not published on the current pricing page |
| `gpt-5-codex` | $1.25 | $0.125 | $10.00 | not published on the current pricing page |

The older model pages establish the Standard rates. Several are marked deprecated. They use legacy caching with no separate cache-write price. Avoid manufacturing Fast rates for models omitted from the current Fast pricing table.

## Lifetime and retention

### GPT-5.6 and later

* Use `prompt_cache_options.ttl`.
* The only supported value is `"30m"`, and it is the default.
* A cached prefix remains eligible for reuse for at least 30 minutes after its most recent write or reuse. OpenAI may retain it longer.
* Reuse refreshes the lifetime without another cache-write charge.
* The minimum cacheable prefix is 1,024 visible input tokens.

### GPT-5.5 and earlier

* Use legacy `prompt_cache_retention`.
* GPT-5.5 and GPT-5.5 Pro support `"24h"` only. Entries are typically available for around 30 minutes and may remain available for up to 24 hours.
* Other supported earlier models can use `"in_memory"` or `"24h"`. `in_memory` is typically active for about 5 to 10 minutes of inactivity, up to one hour. `24h` is typically active around 30 minutes and may last up to 24 hours.
* For models supporting both settings, organizations without Zero Data Retention default to `24h`; organizations with Zero Data Retention default to `in_memory`. Availability must still be checked for the model and organization.
* Reuse refreshes the lifetime, but these legacy windows are not minimum guarantees.
* Extended retention is documented for `gpt-5.5`, `gpt-5.5-pro`, `gpt-5.4`, `gpt-5.2`, `gpt-5.1-codex-max`, `gpt-5.1`, `gpt-5.1-codex`, `gpt-5.1-codex-mini`, `gpt-5.1-chat-latest`, `gpt-5`, `gpt-5-codex`, and `gpt-4.1`.

## Telemetry and cache-warm estimation

Responses report actual use in:

* `usage.input_tokens_details.cached_tokens`
* `usage.input_tokens_details.cache_write_tokens`
* `usage.input_tokens`

GPT-5.6 and later also support prompt cache diagnostics in the Responses API. Diagnostics can classify a comparison as `cache_hit`, `cache_miss`, `comparison_response_not_found`, or `unavailable`, but they do not expose a cache entry's expiry timestamp. Diagnostic records themselves expire after a short period independently of the prompt cache.

There is no documented cache-entry `expires_at`, cache age, manual refresh endpoint, or manual clearing endpoint. A warm indicator must therefore be an estimate derived from observed reads or writes, not a statement of server state. A session alone does not guarantee a cache hit, and machine routing can still prevent reuse.

Recommended UI state:

* Record `lastCacheObservedAt` only when a response reports nonzero `cached_tokens` or `cache_write_tokens` for the tracked prefix.
* For GPT-5.6 and later, set `estimatedWarmUntil = lastCacheObservedAt + 30 minutes`. Label the state as estimated or likely, not guaranteed.
* For legacy `24h`, do not show a precise 24-hour countdown. The documentation describes 24 hours as a maximum, with around 30 minutes typical. Show a qualitative likely-warm state based on the last observation.
* For legacy `in_memory`, do not promise more than the observed state. The documented 5-to-10-minute inactivity window is typical, not guaranteed.
* Replace estimates with the result of the next real request. Use actual token telemetry for accounting.

## Accounting formula

For GPT-5.6 and later:

```text
ordinary_input_tokens = input_tokens - cached_tokens - cache_write_tokens

input_cost = (
  ordinary_input_tokens * input_rate
  + cached_tokens * cache_read_rate
  + cache_write_tokens * cache_write_rate
) / 1_000_000

total_cost = input_cost + output_tokens * output_rate / 1_000_000
```

For GPT-5.5 and earlier, there is no separate cache-write rate:

```text
ordinary_input_tokens = input_tokens - cached_tokens

input_cost = (
  ordinary_input_tokens * input_rate
  + cached_tokens * cache_read_rate
) / 1_000_000

total_cost = input_cost + output_tokens * output_rate / 1_000_000
```

Select the rate table from the actual resolved service tier and context band. Do not infer Priority or Fast prices by multiplying Standard prices when a price is not published. Regional processing may add a documented 10 percent uplift for eligible models released on or after 2026-03-05, so a complete bill estimator must include the actual region.

## Keep-warm strategy

For GPT-5.6 and later, a reuse before the 30-minute minimum lifetime ends refreshes the lifetime. If keep-warm traffic is justified, schedule it around 25 to 28 minutes after the last confirmed read or write, preserve the exact reusable prefix and cache-affecting settings, and keep the new suffix and output minimal. Reset the schedule from the completed response only when telemetry confirms a read or write. Back off when the tracked task is active because normal traffic already refreshes the entry.

For legacy `24h`, a 25-to-28-minute cadence is a best-effort choice based on the documented typical window, not a guarantee. For legacy `in_memory`, even a sub-five-minute cadence cannot be presented as guaranteed. Prefer `24h` when supported and permitted.

Every keep-warm request still incurs cached-input charges, plus uncached suffix and output charges, and counts toward request and token limits. Keep-warm is economical only when the expected avoided rewrite and recomputation cost exceeds the keep-warm requests. It should be disabled by default for inactive or low-reuse tasks.

## ChatGPT subscription implication

With an API key, Codex follows API token pricing rather than ChatGPT plan credits. The API processing tier and region can change that price.

When signed in with ChatGPT, Codex uses subscription access, plan allowances, or workspace credits. OpenAI publishes the following Standard speed credit rates per million tokens for the GPT-6 lineup. Unlike API billing, Codex credit billing has no separate cache write charge.

| Model | Input credits | Cached input credits | Output credits | Fast multiplier where available |
| --- | ---: | ---: | ---: | ---: |
| GPT-6 Astra | 250 | 25 | 1,250 | 2.5 times |
| GPT-6 Sol | 50 | 5 | 250 | 2.5 times |
| GPT-6 Luna | 2.5 | 0.25 | 12.5 | 2.5 times |

These credit rates are not a formula for included subscription allowance. The amount of work allowed per plan varies with model, context, reasoning, tools, cache use, speed, and rollout. They also do not determine an Enterprise agreement's USD rate card. Therefore:

* Show API-priced sessions as billed cost.
* For ChatGPT-authenticated sessions, show token statistics and, if useful, an explicitly named API-equivalent estimate. Do not label it as the user's charged cost or credit consumption.
* Keep-warm messages consume plan usage even when they produce a cache hit. Their API-equivalent cost is not proof of their subscription-credit cost.
* Do not equate an Enterprise plan's priority request processing with API Fast or Priority token billing.

## Desktop implementation

The local build changes the existing composer context indicator and adds Context cache under Settings, Agent. Keep warm starts disabled with a 30 minute inactivity horizon. The per task switch overrides the global default. The duration is how long to continue idle refreshes after user activity, not a server retention request. Refresh messages do not renew that horizon. Draft input postpones refreshes, and active, queued, closed, failed, custom provider, and expired observations do not trigger refreshes. No work is scheduled while the app is closed.

The countdown uses observed cache reads or writes from the task rollout, plus a cacheable first request as estimated priming when cache write telemetry is absent. GPT-6 Astra, Sol, and Luna, GPT-5.6, Daybreak Blue's current Sol alias, and GPT-5.5 use a 30 minute estimate. Older supported models whose actual retention policy is unavailable use a conservative five minute estimate. An elapsed estimate is not proof that the server discarded the prefix. Compaction, model changes and cache misses invalidate the observation. The indicator describes a reusable prefix, not a guarantee that every token in the current context is cached.

Costs are token based API equivalents in USD using the dated rate table. Each request uses its recorded model and context band. New turns persist the requested service tier because older rollout records do not necessarily include it. Historical records without a tier use Standard pricing; the app server does not expose the final upstream billing tier. Unknown prices or incomplete counters produce unavailable or partial estimates rather than invented rates. Tool fees, separate descendant tasks, regional uplifts and subscription credit accounting are not included. Refresh usage is included. Duplicate token notifications do not rebill, and counter resets are not treated as requests.

The app server resumes the same loaded task for each refresh and sends the requested message without changing model, effort, tools, permissions, or instructions. This preserves the reusable prefix as far as the client controls it, but routing and dynamic context can still cause a miss. The installed Codex application is not patched; these changes are packaged into a separate CodexZero build.

## Official sources

* [Prompt caching guide](https://developers.openai.com/api/docs/guides/prompt-caching)
* [Prompt cache diagnostics](https://developers.openai.com/api/docs/guides/prompt-caching/diagnostics)
* [API pricing](https://developers.openai.com/api/docs/pricing)
* [GPT-6 Astra model](https://developers.openai.com/api/docs/models/gpt-6-astra)
* [GPT-6 Sol model](https://developers.openai.com/api/docs/models/gpt-6-sol)
* [GPT-6 Luna model](https://developers.openai.com/api/docs/models/gpt-6-luna)
* [GPT-5.6 Sol model](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
* [GPT-5.6 Terra model](https://developers.openai.com/api/docs/models/gpt-5.6-terra)
* [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
* [GPT-5.5 model](https://developers.openai.com/api/docs/models/gpt-5.5)
* [GPT-5.3 Codex model](https://developers.openai.com/api/docs/models/gpt-5.3-codex)
* [GPT-5.2 Codex model](https://developers.openai.com/api/docs/models/gpt-5.2-codex)
* [GPT-5.1 Codex model](https://developers.openai.com/api/docs/models/gpt-5.1-codex)
* [GPT-5.1 Codex Max model](https://developers.openai.com/api/docs/models/gpt-5.1-codex-max)
* [GPT-5.1 Codex Mini model](https://developers.openai.com/api/docs/models/gpt-5.1-codex-mini)
* [GPT-5 Codex model](https://developers.openai.com/api/docs/models/gpt-5-codex)
* [Codex authentication](https://learn.chatgpt.com/docs/auth)
* [Codex pricing and plan usage](https://learn.chatgpt.com/docs/pricing)
* [Codex speed and Fast credit rates](https://learn.chatgpt.com/docs/agent-configuration/speed)
* [API Fast mode](https://developers.openai.com/api/docs/guides/fast-mode)
