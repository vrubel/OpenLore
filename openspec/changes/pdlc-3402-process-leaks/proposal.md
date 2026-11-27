# Change: консолидация решений и сервер MCP не оставляют процессов

Локальное изменение форка `vrubel/openlore` для карточки PDLC-3414 (PDLC-3407 п. 3) эпика Jira PDLC-3402 «Утечки
процессов Maestro», канон линии — PDLC-3411. Эпик хранилища OpenSpec продукта — `pdlc-3402-process-leaks` в
`vrubel/pdlc-maestro-spec-store` (коллектор `collector/pdlc-3402-leaks`): требование F-OPS-021.R3, задача 3.1 его
`tasks.md`. База — коммит тега пина установщика `v2.1.3-ru20` (`24055a01e7fd3385739a37efa0b81b3c2f724cd8`;
`scripts/forks.lst:108` pdlc-core `9f42086a`), коллектор `collector/pdlc-3402-leaks`. Источник требований — пакет
источников `pdlc-3402-leaks-v1` (`vrubel/pdlc-source-packs`, коммит `acdbb9338105a25a4ae0cdf898b07300990c663d`).

## Why

Инструмент `record_decision` после записи решения вызывает `spawnConsolidateBackground`
(`src/core/services/mcp-handlers/decisions.ts:28-53`, вызов — строка 174), который порождает
`openlore decisions --consolidate` с `detached: true` и `unref()`. Процесс консолидации живёт в своей группе и
переживает сервер `openlore mcp`, которого Maestro гасит: на каждый вызов остаётся `node` и, возможно, CLI агента, до
~5 минут (`leak-report.md` пакета, строка 19). Сервер `openlore mcp --http` не следит за своим stdin, поэтому после
аварийной гибели родителя — сервера Maestro — живёт до перезагрузки и копится с каждым падением (там же, строка 1 и
исправление И1).

## What Changes

- **mcp-handlers** (ADDED `DecisionConsolidationDoesNotOutliveMcpServer`): консолидация решений порождается без
  отделения, в группе сервера MCP, либо гасится при закрытии сервера; после закрытия сервера тем способом, каким его
  закрывает ядро Maestro (сигнал номеру процесса или его группе), процесса консолидации нет.
- **cli** (ADDED `McpServerExitsOnStdinCloseWhenAsked`): сервер `openlore mcp`, запущенный с ключом
  `--exit-on-stdin-close`, выходит по закрытию stdin — в режиме stdio и с `--http`. Без ключа поведение прежнее: stdin из
  `/dev/null` (systemd, `nohup`, docker без `-i`) сервер не останавливает.

Новых отказов, остановок, обязательных шагов и условий запуска изменение не вводит: выход по закрытию stdin — только
по явному ключу.

## Связь

- Тег форка и пин установщика (`scripts/forks.lst` pdlc-core) — только по отдельному слову владельца, записанному в
  PDLC-3414 (план линии, комментарий 32184): без него тег не ставится и пин не двигается.
- Ядро сейчас запускает `openlore mcp --http` со stdin `ignore` (`scripts/lib/ports/openlore-http.mjs:422-428`
  pdlc-core `9f42086a`). Вместе со сдвигом пина ядро начинает передавать ключ `--exit-on-stdin-close` и трубу stdin
  (задача 11 локального изменения ядра). Без ключа новый тег ведёт себя как прежний, поэтому порядок сдвига не жёсткий.
- Что не воспроизводится на Linux-раннере (macOS, Windows), отмечается явно; живое подтверждение снимает владелец.
