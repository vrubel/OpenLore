# cli spec delta

## ADDED Requirements

### Requirement: McpServerExitsOnStdinCloseWhenAsked

Сервер `openlore mcp`, запущенный с ключом `--exit-on-stdin-close`, SHALL выходить по закрытию stdin — и в режиме
stdio, и с `--http`. Так сервер не переживает родителя, погибшего мимо сигнала. Без ключа поведение сервера SHALL
оставаться прежним: stdin из `/dev/null` (stdio `ignore` у Node, systemd, `nohup`, docker без `-i`) сервер не
останавливает.

#### Scenario: Родитель закрыл трубу stdin сервера с --http

- **GIVEN** сервер `openlore mcp --http --exit-on-stdin-close`, запущенный со stdin-трубой родителя и отвечающий на
  запросы
- **WHEN** родитель закрывает трубу stdin или погибает от SIGKILL
- **THEN** сервер выходит, его порт свободен

#### Scenario: Закрыт stdin сервера в режиме stdio

- **GIVEN** сервер `openlore mcp --exit-on-stdin-close` в режиме stdio, ответивший клиенту на запрос
- **WHEN** клиент закрывает stdin сервера
- **THEN** процесс сервера выходит

#### Scenario: Без ключа поведение прежнее

- **GIVEN** сервер `openlore mcp --http` без ключа `--exit-on-stdin-close`, запущенный со stdin из `/dev/null`
- **WHEN** проходит время, за которое сервер с ключом уже вышел бы
- **THEN** сервер жив и отвечает на запросы
