# cli spec delta

## ADDED Requirements

### Requirement: McpServerExitsOnStdinClose

Сервер `openlore mcp` SHALL выходить по закрытию stdin — и в режиме stdio, и с `--http`. Так сервер не переживает
родителя, погибшего мимо сигнала.

#### Scenario: Родитель закрыл stdin сервера с --http

- **GIVEN** сервер `openlore mcp --http`, запущенный со stdin-трубой родителя
- **WHEN** родитель закрывает трубу stdin или погибает от SIGKILL
- **THEN** сервер выходит, его порт свободен
