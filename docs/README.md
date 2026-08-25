# Documentation

[← Back to the README](../README.md)

Two kinds of document live here, and the split is the point: **current** docs
describe how the thing works now and are meant to be followed; **history** docs
describe work that is already finished and are kept for the reasoning, not as
instructions.

---

## Start here

| | |
|---|---|
| [architecture.md](architecture.md) | How the four Workers fit together, and why they are four |
| [operations.md](operations.md) | **The runbook.** Secrets, migrations, `npm run dev`, deploying, onboarding a client |
| [api.md](api.md) | Every HTTP route, with request and response shapes |

## Reference

Feature-by-feature, all describing behaviour that is live:

| | |
|---|---|
| [tenancy.md](tenancy.md) | Organizations, row-level security, the origin lock |
| [providers.md](providers.md) | The vendor catalog, resolution order, running for free |
| [bot-configuration.md](bot-configuration.md) | Every field on a bot and what reads it |
| [knowledge.md](knowledge.md) | Sources, chunking, embedding, retrieval, failure modes |
| [knowledge-pipeline.md](knowledge-pipeline.md) | The ingestion path in detail |
| [business-profile.md](business-profile.md) | The structured profile and how it reaches the prompt |
| [lead-capture.md](lead-capture.md) | Extraction, storage, notification, CSV export |
| [usage-metering.md](usage-metering.md) | What is counted, where it is stored, what prunes it |
| [demo-bot-knowledge.md](demo-bot-knowledge.md) | The bot behind the landing page's live widget |
| [roadmap.md](roadmap.md) | What is built, what is deferred, and why |

## History

Finished work, written up while it was fresh. Useful when you want to know *why*
something is the way it is; **not** a set of steps to follow — several describe a
repo layout that has since changed.

| | |
|---|---|
| [history/deployment-rebuild.md](history/deployment-rebuild.md) | The move from one Pages project to four Workers |
| [history/rag-hardening.md](history/rag-hardening.md) | Retrieval quality: chunking, ranking, evaluation |
| [history/landing-redesign.md](history/landing-redesign.md) | The landing page rebuild |
| [history/widget-polish.md](history/widget-polish.md) | Widget interaction and rendering work |
| [history/phase-2b.md](history/phase-2b.md) | An earlier phase plan |

> These predate the removal of staging and of the test/check script suite, so
> commands and file paths inside them may no longer exist. [operations.md](operations.md)
> is the current answer whenever they disagree.

---

## Elsewhere in the repo

| | |
|---|---|
| [../supabase/README.md](../supabase/README.md) | The six migrations and what each one establishes |
| [../packages/brand/README.md](../packages/brand/README.md) | Brand assets, and [FONTS.md](../packages/brand/FONTS.md) for font provenance |
| [../CHANGELOG.md](../CHANGELOG.md) | Every release, newest first |
