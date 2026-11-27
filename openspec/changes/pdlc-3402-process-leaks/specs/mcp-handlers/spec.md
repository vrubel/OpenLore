# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DecisionConsolidationDoesNotOutliveMcpServer

Консолидация решений, которую порождает инструмент `record_decision` (`spawnConsolidateBackground`,
`src/core/services/mcp-handlers/decisions.ts:28-53`), SHALL порождаться без отделения (без `detached: true`), в группе
процессов сервера MCP, либо SHALL гаситься при закрытии сервера (`close`). Консолидация и её потомки (CLI агента,
который она вызывает) MUST NOT переживать закрытие сервера теми способами, которые покрывает это решение: SIGTERM
номеру процесса сервера, по которому сервер выходит; сигнал группе, в которой стоит сервер; гашение дерева сервера по
номерам. Чужие процессы MUST NOT получать сигнала.

#### Scenario: Сервер MCP закрыт, пока консолидация работает

- **GIVEN** сервер `openlore mcp --http`, запущенный ядром Maestro, и рядом живущий чужой процесс-свидетель
- **WHEN** инструмент `record_decision` записал решение, консолидация ещё работает и ждёт медленный CLI агента, а сервер
  закрыт одним из способов ядра на pdlc-core `9f42086a`: SIGTERM номеру процесса, по которому сервер вышел (`close()`,
  `scripts/lib/ports/openlore-http.mjs:445`); SIGTERM, затем SIGKILL группе прогона, в которой стоит сервер (`killTree`,
  `scripts/lib/proc-util.mjs:123`, `:132`); SIGTERM, затем SIGKILL каждому номеру дерева сервера (`killSubtree`,
  `scripts/lib/proc-util.mjs:1636-1650`)
- **THEN** при каждом из этих способов процесс `openlore decisions --consolidate` и его потомки не живы
- **AND** процесс-свидетель жив
