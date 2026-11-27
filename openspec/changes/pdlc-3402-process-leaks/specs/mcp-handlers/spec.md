# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DecisionConsolidationDoesNotOutliveMcpServer

Консолидация решений, которую порождает инструмент `record_decision` (`spawnConsolidateBackground`,
`src/core/services/mcp-handlers/decisions.ts:28-53`), SHALL порождаться без отделения (без `detached: true`), в группе
процессов сервера MCP, либо SHALL гаситься при закрытии сервера MCP. Процесс консолидации MUST NOT переживать закрытие
сервера ни одним из способов, какими его закрывает ядро Maestro: сигналом номеру процесса сервера или его группе.
Неотделённый потомок, которому сигнал не дошёл, по одному этому не гибнет, поэтому выбранное решение SHALL покрывать
и SIGKILL номеру процесса сервера. Чужие процессы MUST NOT получать сигнала.

#### Scenario: Сервер MCP закрыт так, как его закрывает ядро

- **GIVEN** сервер `openlore mcp --http`, запущенный ядром Maestro, и рядом живущий чужой процесс-свидетель
- **WHEN** инструмент `record_decision` записал решение и породил консолидацию, а затем сервер закрыт одним из
  способов ядра на pdlc-core `9f42086a`: SIGTERM номеру процесса и по сроку SIGKILL (`close()`,
  `scripts/lib/ports/openlore-http.mjs:439-446`); SIGKILL номеру процесса (`killAllOpenloreHttpSync`,
  `scripts/lib/ports/openlore-http.mjs:237`); SIGTERM, затем SIGKILL каждому номеру дерева (`killSubtree`,
  `scripts/lib/proc-util.mjs:1636-1650`); SIGKILL группе (`killGroupSync`, `scripts/lib/proc-util.mjs:57-67`)
- **THEN** при каждом из этих способов процесс `openlore decisions --consolidate` не жив
- **AND** процесс-свидетель жив
