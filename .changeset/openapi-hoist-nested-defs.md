---
'@mastra/server': patch
---

Fix unresolvable `$ref`s in the served OpenAPI document (`/api/openapi.json`). Schemas converted per route carried nested `$defs`/`definitions` blocks whose refs dangled at document root; they are now hoisted into `components.schemas` and the refs rewritten to `#/components/schemas/<name>`.
