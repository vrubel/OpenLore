# mcp-handlers spec delta

## ADDED Requirements

### Requirement: DecisionConsolidationDoesNotOutliveMcpServer

Консолидация решений, которую порождает инструмент `record_decision` (`spawnConsolidateBackground`,
`src/core/services/mcp-handlers/decisions.ts`), SHALL порождаться без отделения (без `detached: true`), в группе
процессов сервера MCP, либо SHALL гаситься при закрытии сервера MCP. После закрытия сервера MCP процесс консолидации
решений MUST NOT оставаться живым. Чужие процессы MUST NOT получать сигнала.

#### Scenario: Сервер MCP закрыт после записи решения

- **GIVEN** сервер `openlore mcp` и рядом живущий чужой процесс-свидетель
- **WHEN** инструмент `record_decision` записал решение и породил консолидацию, а сервер MCP закрыт
- **THEN** процесс `openlore decisions --consolidate` не жив
- **AND** процесс-свидетель жив
