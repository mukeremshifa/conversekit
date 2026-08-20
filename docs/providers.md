# AI providers

Eleven vendors behind one interface, how resolution works, and how to run the whole thing for free.

[← Back to the README](../README.md)

---

## AI vendors

Every vendor is normalised onto one interface — `generate`, `stream`, `embed` —
so swapping providers is configuration, not code. Most vendors speak the OpenAI
chat-completions shape and are therefore catalog entries rather than adapters;
only Anthropic, Google and Workers AI need their own translation.

Selection resolves most-specific-first:

1. the bot's own `provider_config` (per tenant, supports BYOK)
2. Worker env — `AI_VENDOR`, `AI_MODEL`, `AI_BASE_URL`, …
3. the vendor preset in [`src/providers/catalog.ts`](../src/providers/catalog.ts)

| Vendor id | Notes |
|---|---|
| `openai` `anthropic` `google` | The majors |
| `groq` `openrouter` `mistral` | Have usable free tiers |
| `deepseek` `together` | Cheap hosted |
| `workers-ai` | No key needed; requires the `[ai]` binding |
| `ollama` `lmstudio` | Local, no key |
| `custom` | Any OpenAI-compatible server — vLLM, llama.cpp, LiteLLM |

Embeddings resolve separately from chat (`EMBEDDING_VENDOR`), because a tenant
will often want a strong hosted chat model alongside cheap local embeddings —
and re-embedding a corpus just to follow a chat-model change is pointless.
Anthropic has no embeddings API and fails with a clear error if selected.

### Running for free

Platform defaults in [wrangler.toml](../wrangler.toml) are **Gemini for chat**
(`gemini-3.5-flash-lite`) and **Workers AI for embeddings**
(`@cf/baai/bge-base-en-v1.5`). Both have free tiers, so a bot with no
`provider_config` costs nothing to run, RAG included.

The constraint that decides the embedding half: the pgvector column is
`vector(768)`, and only Workers AI, Ollama and LM Studio produce 768 dimensions
for free. Mistral's are 1024 and will be rejected at ingest — the Providers
screen warns before you can pick it. Ollama is free and unlimited but the
deployed Worker cannot reach `localhost`, so it is a local-development option
only.

---
